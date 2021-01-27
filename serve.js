// University of Illinois/NCSA
// Open Source License
// http://otm.illinois.edu/disclose-protect/illinois-open-source-license

// Copyright (c) 2020 Grainger Engineering Library Information Center.  All rights reserved.

// Developed by: IDEA Lab
//               Grainger Engineering Library Information Center - University of Illinois Urbana-Champaign
//               https://library.illinois.edu/enx

// Permission is hereby granted, free of charge, to any person obtaining a copy of
// this software and associated documentation files (the "Software"), to deal with
// the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
// of the Software, and to permit persons to whom the Software is furnished to
// do so, subject to the following conditions:
// * Redistributions of source code must retain the above copyright notice,
//   this list of conditions and the following disclaimers.
// * Redistributions in binary form must reproduce the above copyright notice,
//   this list of conditions and the following disclaimers in the documentation
//   and/or other materials provided with the distribution.
// * Neither the names of IDEA Lab, Grainger Engineering Library Information Center,
//   nor the names of its contributors may be used to endorse or promote products
//   derived from this Software without specific prior written permission.

// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
// CONTRIBUTORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS WITH THE
// SOFTWARE.


const fs = require('fs');
const path = require('path');
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const app = require('express')();
const server = require('http').createServer(app);
const io = require('socket.io')(server, { cookie: false });
const mysql = require('mysql');
const { ExpressPeerServer } = require('peer');

// configuration
const config = require('./config');
if (config.db.host && config.db.host != "") {
    var pool = mysql.createPool(config.db);
}

// setup logging
const { createLogger, format, transports } = require('winston');
const { combine, timestamp, printf } = format;

const printFormat = printf(({ level, message, timestamp }) => {
  return `${timestamp} ${level}: ${message}`;
});

const logger = createLogger({
    format: combine(
        timestamp(),
        printFormat
    ),
    transports: [
        new transports.Console(),
        new transports.File({ filename: 'log.txt' })
    ],
    exitOnError: false
});

const CAPTURE_PATH = './captures/';
const POS_FIELDS = 14;
const POS_BYTES_PER_FIELD = 4;
const POS_CHUNK_SIZE = POS_FIELDS * POS_BYTES_PER_FIELD;
const INT_FIELDS = 7;
const INT_BYTES_PER_FIELD = 4;
const INT_CHUNK_SIZE = INT_FIELDS * INT_BYTES_PER_FIELD;

// session state maps
var sessions = new Map();
var chats = new Map();

// write buffers are multiples of corresponding chunks
const POS_WRITE_BUFFER_SIZE = 1024 * POS_CHUNK_SIZE;
const INT_WRITE_BUFFER_SIZE = 128 * INT_CHUNK_SIZE;
const MIC_WRITE_BUFFER_SIZE = 350000; // TODO(rob): best size? 

// interaction event values
 const INTERACTION_LOOK          = 0;
 const INTERACTION_LOOK_END      = 1;
 const INTERACTION_RENDER        = 2;
 const INTERACTION_RENDER_END    = 3;
 const INTERACTION_GRAB          = 4;
 const INTERACTION_GRAB_END      = 5;
 const INTERACTION_SCENE_CHANGE  = 6;
 const INTERACTION_UNSET         = 7; // NOTE(rob): this value is currently unused. 2020-12-1
 const INTERACTION_LOCK          = 8;
 const INTERACTION_LOCK_END      = 9;


if (!fs.existsSync(CAPTURE_PATH)) {
    logger.info(`Creating directory for session captures: ${CAPTURE_PATH}`)
    fs.mkdirSync(CAPTURE_PATH);
}

// used to convert raw audio pcm data into format ready for speech-to-text
function convertFloat32ToInt16(buffer) {
    l = buffer.length;
    buf = new Int16Array(l);
    while (l--) {
      buf[l] = Math.min(1, buffer[l])*0x7FFF;
    }
    return buf;
}

// generate formatted path for session capture files
function getCapturePath(session_id, start, type) {
    return path.join(__dirname, CAPTURE_PATH, session_id.toString(), start.toString(), type);
}

// main relay handler
io.on('connection', function(socket) {
    logger.info(`Connection: ${socket.id}`);

    socket.on('join', function(data) {
        logger.info(`Join: ${data}`);
        let session_id = data[0];
        let client_id = data[1];
        if (client_id && session_id) {
            let session = sessions.get(session_id);
            if (!session) {
                logger.info(`Creating session: ${session_id}`)
                sessions.set(session_id, {
                    sockets: {}, // socket.id -> client_id
                    clients: [],
                    entities: [],
                    scene: null,
                    isRecording: false,
                    start: Date.now(),
                    recordingStart: 0,
                    seq: 0,
                    writers: {
                        pos: {
                            buffer: Buffer.alloc(POS_WRITE_BUFFER_SIZE),
                            cursor: 0
                        },
                        int: {
                            buffer: Buffer.alloc(INT_WRITE_BUFFER_SIZE),
                            cursor: 0
                        },
                        mic: {
                            buffer: Buffer.alloc(MIC_WRITE_BUFFER_SIZE),
                            cursor: 0
                        }
                    }
                });
                session = sessions.get(session_id);
            }

            // bump any existing connections with this client id
            if (session.clients.includes(client_id)) {
                // remove socket->client mapping
                for (socket_id in session.sockets) {
                    if (session.sockets[socket_id].client_id == client_id) {
                        logger.warn(`Client has existing connection. Bumping old socket ${socket_id} for client: ${client_id}`);
                        let old_socket = session.sockets[socket_id].socket;
                        setTimeout(() => old_socket.disconnect(true), 500); // delay half a second and then bump the old socket
                    }
                }
            }

            // relay server joins connecting client to session room
            socket.join(session_id.toString(), function (err) {
                if (err) { console.log(err); }
                else {
                    let session = sessions.get(session_id);
                    io.to(session_id.toString()).emit('joined', client_id);
                    if (session.clients.length > 0) {
                        session.clients.push(client_id);
                    } else {
                        session.clients = [client_id];
                    }
                    // socket to client mapping
                    session.sockets[socket.id] = { client_id: client_id, socket: socket };

                    // write join event to database
                    if (pool) {
                        let event = `"connect"`;
                        pool.query(
                            "INSERT INTO connections(timestamp, session_id, client_id, event) VALUES(?, ?, ?, ?)", [Date.now(), session_id, client_id, event],
                            (err, res) => {
                                if (err != undefined) {
                                    logger.error(`Error writing join event to database: ${err} ${res}`);
                                }
                            }
                        );
                    }
                }
            });
        }
    });

    socket.on('state', function(data) {
        logger.info(`State: ${data}`)
        if (data) {
            let session_id = data.session_id;
            let client_id = data.client_id;
            if (session_id && client_id) {
                let version = data.version;
                let session = sessions.get(session_id);
                if (session) {
                    let state = {};
                    // check requested api version
                    if (version === 2) {
                        state = {
                            clients: session.clients,
                            entities: session.entities,
                            scene: session.scene,
                            isRecording: session.isRecording
                        }
                    } else { // version 1 or no api version indicated
                        let entities = [];
                        let locked = [];
                        for (let i = 0; i < session.entities.length; i++) {
                            entities.push(session.entities[i].id);
                            if (session.entities[i].locked) {
                                locked.push(session.entities[i].id);
                            }
                        }
                        state = {
                            clients: session.clients,
                            entities: entities,
                            locked: locked,
                            scene: session.scene,
                            isRecording: session.isRecording
                        }
                    }
                    // emit versioned state data
                    io.to(session_id).emit('state', state);
                }
            }
        }
    });

    socket.on('draw', function(data) {
        let session_id = data[1];
        let client_id = data[2];
        if (session_id && client_id) {
            socket.to(session_id.toString()).emit('draw', data);
        }
    });
  
    // session capture handler
    socket.on('start_recording', function(session_id) { // TODO(rob): require client id and token
        if (session_id) {
            let session = sessions.get(session_id);
            if (session && !session.isRecording) {
                session.isRecording = true;
                session.recordingStart = Date.now();
                let path = getCapturePath(session_id, session.recordingStart, '');
                fs.mkdir(path, { recursive: true }, (err) => {
                    if(err) logger.warn(`Error creating capture path: ${err}`);
                });
                let capture_id = session_id+'_'+session.recordingStart;
                pool.query(
                    "INSERT INTO captures(capture_id, session_id, start) VALUES(?, ?, ?)", [capture_id, session_id, session.recordingStart],
                    (err, res) => {
                        if (err != undefined) {
                            logger.error(`Error writing recording start event to database: ${err} ${res}`);
                        }
                    }
                );
                logger.info(`Capture started: ${session_id}`);
            } else if (session && session.isRecording) {
                logger.warn(`Requested session capture, but session is already recording: ${session_id}`)
            } else {
                logger.warn(`Error starting capture for session: ${session_id}`);
            }
        }
    });

    // define end_recording event handler, use on socket event as well as on server cleanup for empty sessions
    function end_recording(session_id) {
        if (session_id) {
            let session = sessions.get(session_id);
            if (session && session.isRecording) {
                session.isRecording = false;
                logger.info(`Capture ended: ${session_id}`);                
                // write out the buffers if not empty, but only up to where the cursor is

                let pos_writer = session.writers.pos;
                if (pos_writer.cursor > 0) {
                    let path = getCapturePath(session_id, session.recordingStart, 'pos');
                    let wstream = fs.createWriteStream(path, { flags: 'a' });
                    wstream.write(pos_writer.buffer.slice(0, pos_writer.cursor));
                    wstream.close();
                    pos_writer.cursor = 0;
                }
                let int_writer = session.writers.int;
                if (int_writer.cursor > 0) {
                    let path = getCapturePath(session_id, session.recordingStart, 'int');
                    let wstream = fs.createWriteStream(path, { flags: 'a' });
                    wstream.write(int_writer.buffer.slice(0, int_writer.cursor));
                    wstream.close();
                    int_writer.cursor = 0;
                }
                // let mic_writer = session.writers.mic;
                // if (mic_writer.cursor > 0) {
                //     let path = CAPTURE_PATH+session_id+'_'+session.recordingStart+'.mic';
                //     let wstream = fs.createWriteStream(path, { flags: 'a' });
                //     wstream.write(mic_writer.buffer.slice(0, mic_writer.cursor));
                //     wstream.close();
                //     mic_writer.cursor = 0;
                // }
                
                // write the capture end event to database
                if (pool) {
                    let capture_id = session_id+'_'+session.recordingStart;
                    pool.query(
                        "UPDATE captures SET end = ? WHERE capture_id = ?", [Date.now(), capture_id],
                        (err, res) => {
                            if (err != undefined) {
                                logger.error(`Error writing recording end event to database: ${err} ${res}`);
                            }
                        }
                    );
                }

            } else if (session && !session.isRecording) {
                logger.warn(`Requested to end session capture, but capture is already ended: ${session_id}`)
            } else {
                logger.warn(`Error ending capture for session: ${session_id}`);
            }
        }
    }

    socket.on('end_recording', end_recording);


    // client position update handler
    socket.on('update', function(data) {
        let session_id = data[1];
        let client_id = data[2];
        
        if (session_id && client_id) 
        {  
            // relay updates to all connected clients
            socket.to(session_id.toString()).emit('relayUpdate', data);

            // cache entity states
            let session = sessions.get(session_id);
            if (session) {
                let entity_type = data[4]
                if (entity_type == 3) {
                    let entity_id = data[3]
                    let i = session.entities.findIndex(e => e.id == entity_id);
                    if (i != -1) {
                        session.entities[i].latest = data;
                    } else {
                        let entity = {
                            id: entity_id,
                            latest: data,
                            render: true,
                            locked: false
                        }
                        session.entities.push(entity);
                    }
                }

                // write data to disk if recording
                if (session.isRecording) {
                    // set update time and get diff -- calc seq number from diff / number of milliseconds per seq
                    let now = Date.now();
                    let diff = now - session.start;
                    // session.seq = Math.floor(diff / 10);
                    session.seq = diff;

                    // overwrite last field (dirty bit) with session sequence number
                    data[POS_FIELDS-1] = session.seq;
                    
                    // get reference to session writer (buffer and cursor)
                    let writer = session.writers.pos;

                    if (POS_CHUNK_SIZE + writer.cursor > writer.buffer.byteLength) {
                        // if buffer is full, dump to disk and reset the cursor
                        let path = getCapturePath(session_id, session.recordingStart, 'pos');
                        let wstream = fs.createWriteStream(path, { flags: 'a' });
                        wstream.write(writer.buffer.slice(0, writer.cursor));
                        wstream.close();
                        writer.cursor = 0;
                    }
                    for (let i = 0; i < data.length; i++) {
                        writer.buffer.writeFloatLE(data[i], (i*POS_BYTES_PER_FIELD) + writer.cursor);
                    }
                    writer.cursor += POS_CHUNK_SIZE;
                }
            }
        }
    
    });

    // handle interaction events
    // see `INTERACTION_XXX` declarations for type values
    socket.on('interact', function(data) {
        let session_id = data[1];
        let client_id = data[2];

        if (session_id && client_id) {
            // relay interaction events to all connected clients
            socket.to(session_id.toString()).emit('interactionUpdate', data);

            // do session state update if needed
            let source_id = data[3];
            let target_id = data[4];
            let interaction_type = data[5];
            let session = sessions.get(session_id);
            if (session) {
                // entity should be rendered
                if (interaction_type == INTERACTION_RENDER) {
                    let i = session.entities.findIndex(e => e.id == target_id);
                    if (i != -1) {
                        session.entities[i].render = true;
                    } else {
                        let entity = {
                            id: target_id,
                            latest: [],
                            render: true,
                            locked: false
                        }
                        session.entities.push(entity);
                    }
                }
                // entity should stop being rendered
                if (interaction_type == INTERACTION_RENDER_END) {
                    let i = session.entities.findIndex(e => e.id == target_id);
                    if (i != -1) {
                        session.entities[i].render = false;
                    } else {
                        let entity = {
                            id: target_id,
                            latest: data,
                            render: false,
                            locked: false
                        }
                        session.entities.push(entity);
                    }
                }
                // scene has changed
                if (interaction_type == INTERACTION_SCENE_CHANGE) {
                    session.scene = target_id;
                }
                // entity is locked
                if (interaction_type == INTERACTION_LOCK) {
                    let i = session.entities.findIndex(e => e.id == target_id);
                    if (i != -1) {
                        session.entities[i].locked = true;
                    } else {
                        let entity = {
                            id: target_id,
                            latest: [],
                            render: false,
                            locked: true
                        }
                        session.entities.push(entity);
                    }
                }
                // entity is unlocked
                if (interaction_type == INTERACTION_LOCK_END) {
                    let i = session.entities.findIndex(e => e.id == target_id);
                    if (i != -1) {
                        session.entities[i].locked = false;
                    } else {
                        let entity = {
                            id: target_id,
                            latest: [],
                            render: false,
                            locked: false
                        }
                        session.entities.push(entity);
                    }
                }

                // write to file as binary data
                if (session.isRecording) {
                    // set update time and get diff -- calc seq number from diff / number of milliseconds per seq
                    let now = Date.now();
                    let diff = now - session.start;
                    // session.seq = Math.floor(diff / 10)
                    session.seq = diff;

                    // overwrite last field (dirty bit) with session sequence number
                    data[INT_FIELDS-1] = session.seq;
                    
                    // get reference to session writer (buffer and cursor)
                    let writer = session.writers.int;

                    if (INT_CHUNK_SIZE + writer.cursor > writer.buffer.byteLength) {
                        // if buffer is full, dump to disk and reset the cursor
                        let path = getCapturePath(session_id, session.recordingStart, 'pos');
                        let wstream = fs.createWriteStream(path, { flags: 'a' });
                        wstream.write(writer.buffer.slice(0, writer.cursor));
                        wstream.close();
                        writer.cursor = 0;
                    }
                    for (let i = 0; i < data.length; i++) {
                        writer.buffer.writeInt32LE(data[i], (i*INT_BYTES_PER_FIELD) + writer.cursor);
                    }
                    writer.cursor += INT_CHUNK_SIZE;
                }
            }
        }
    });

    socket.on('disconnect', function(reason) {
        // find which session this socket is in
        for (s of sessions) {
            let session_id = s[0];
            let session = s[1];
            if (socket.id in session.sockets) {
                let client_id = session.sockets[socket.id].client_id;
                // send disconnect event to session
                socket.to(session_id.toString()).emit('disconnected', client_id);
                // remove socket->client mapping
                delete session.sockets[socket.id];
                // remove client from session state
                let index = session.clients.indexOf(client_id);
                session.clients.splice(index, 1);
                logger.info(`Disconnection: ${client_id}`);

                // log disconnect event with timestamp to db
                if (pool) {
                    let event = `"disconnect"`;
                    pool.query(
                        "INSERT INTO connections(timestamp, session_id, client_id, event) VALUES(?, ?, ?, ?)", [Date.now(), session_id, client_id, event],
                        (err, res) => {
                            if (err != undefined) {
                                logger.error(`Error writing disconnect event to database: ${err} ${res}`);
                            }
                        }
                    );

                    // remove session if empty
                    if (session.clients.length <= 0) {
                        logger.info(`No clients left in session, ending: ${session_id}`);
                        if (session.isRecording) {
                            logger.info(`Stopping recording of empty session: ${session_id}`);
                            end_recording(session_id);
                        }
                        sessions.delete(session_id);
                    }
                }
            }
        }
    });

    socket.on('playback', function(data) {
        // TODO(rob): need to use playback object to track seq and group by playback_id, 
        // so users can request to pause playback, maybe rewind?
        logger.info(`Playback request: ${data.playback_id}`);
        let client_id = data.client_id;
        let session_id = data.session_id;
        let playback_id = data.playback_id;

        let capture_id = playback_id.split('_')[0]
        let start = playback_id.split('_')[1]
        // TODO(rob): check that this client has permission to playback this session

        let session = sessions.get(session_id);
    
        // playback sequence counter
        let current_seq = 0;

        // check that all params are valid
        if (client_id && session && capture_id && start) {

            // build audio file manifest
            logger.info(`Buiding audio file manifest for capture replay: ${playback_id}`)
            let audioManifest = [];
            let baseAudioPath = getCapturePath(capture_id, start, 'audio');
            if(fs.existsSync(baseAudioPath)) {
                let items = fs.readdirSync(baseAudioPath);
                items.forEach(clientDir => {
                    let clientPath = path.join(baseAudioPath, clientDir)
                    let files = fs.readdirSync(clientPath)
                    files.forEach(file => {
                        let client_id = clientDir;
                        let seq = file.split('.')[0];
                        let audioFilePath = path.join(clientPath, file);
                        let item = {
                            seq: seq,
                            client_id: client_id,
                            path: audioFilePath,
                            data: null
                        }
                        audioManifest.push(item);
                    });
                });
            }

            // emit audio manifest to connected clients
            io.of('chat').to(session_id.toString()).emit('playbackAudioManifest', audioManifest);

            // stream all audio files for caching and playback by client
            audioManifest.forEach((file) => {
                fs.readFile(file.path, (err, data) => {
                    file.data = data;
                    if(err) logger.error(`Error reading audio file: ${file.path}`);
                    console.log('emitting audio packet:', file);
                    io.of('chat').to(session_id.toString()).emit('playbackAudioData', file);
                });
            });


            // position streaming
            let capturePath = getCapturePath(capture_id, start, 'pos');
            let stream = fs.createReadStream(capturePath, { highWaterMark: POS_CHUNK_SIZE });

            // set actual playback start time
            let playbackStart = Date.now();

            // position data emit loop
            stream.on('data', function(chunk) {

                stream.pause();

                // start data buffer loop
                let buff = Buffer.from(chunk);
                let farr = new Float32Array(chunk.byteLength / 4);
                for (var i = 0; i < farr.length; i++) {
                    farr[i] = buff.readFloatLE(i * 4);
                }
                var arr = Array.from(farr);

                console.log(arr);

                let timer = setInterval( () => {
                    let now = Date.now();
                    current_seq = now - playbackStart;

                    console.log(`=== POS === current seq ${current_seq}; arr seq ${arr[POS_FIELDS-1]}`);

                    if (arr[POS_FIELDS-1] <= current_seq) {
                        // alias client and entity id with prefix if entity type is not an asset
                        if (arr[4] != 3) {
                            arr[2] = 90000 + arr[2];
                            arr[3] = 90000 + arr[3];
                        }
                        io.to(session_id.toString()).emit('relayUpdate', arr);
                        stream.resume();
                        clearInterval(timer);
                    }
                }, 1);
            });

            stream.on('error', function(err) {
                logger.error(`Error creating position playback stream for ${playback_id} ${start}: ${err}`);
                io.to(session_id.toString()).emit('playbackEnd')
            });

            stream.on('end', function() {
                logger.info(`End of pos data for playback session: ${session_id}`)
                io.to(session_id.toString()).emit('playbackEnd')
            })

            // interaction streaming
            let ipath = getCapturePath(capture_id, start, 'int');
            let istream = fs.createReadStream(ipath, { highWaterMark: INT_CHUNK_SIZE });


            istream.on('data', function(chunk) {
                let buff = Buffer.from(chunk);
                let farr = new Int32Array(chunk.byteLength / 4);
                for (var i = 0; i < farr.length; i++) {
                    farr[i] = buff.readInt32LE(i * 4);
                }
                var arr = Array.from(farr);

                console.log(`=== INT === current seq ${current_seq}; arr seq ${arr[INT_FIELDS-1]}`);

                let timer = setInterval( () => {
                    // current_seq = now - playbackStart; this is updated by the pos emit loop i think? 

                    console.log(`=== INT === current seq ${current_seq}; arr seq ${arr[INT_FIELDS-1]}`);

                    if (arr[INT_FIELDS-1] <= current_seq) {
                        io.to(session_id.toString()).emit('interactionUpdate', arr);
                        istream.resume();
                        clearInterval(timer);
                    }
                }, 1);

            });

            istream.on('error', function(err) {
                logger.error(`Error creating interaction playback stream for session ${session_id}: ${err}`);
                io.to(session_id.toString()).emit('interactionpPlaybackEnd')
            });

            istream.on('end', function() {
                logger.info(`End of int data for playback session: ${session_id}`)
                io.to(session_id.toString()).emit('interactionPlaybackEnd')
            })
        }
    })

});


// server namespace for chat signaling and messaging
var chat = io.of('/chat');
chat.on('connection', function(socket) {
    // setup text chat relay
    socket.on('micText', function(data) {
        let session_id = data.session_id;
        io.of('chat').to(session_id).emit('micText', data);
    })

    socket.on('message', function(data) {
        if (data.session_id && data.client_id) {
            socket.to(data.session_id.toString()).emit('message', data);
        }
    });

    socket.on('join', function(data) {
        let session_id = data[0];
        let client_id = data[1];
        if (client_id && session_id) {
            if (!chats.get(session_id)) {
                // empty chat state tracker
                chats.set(session_id, { sockets: {} });
            }
            socket.join(session_id.toString(), function (err) {
                if (err) { console.log(err); }
                else {
                    logger.info(`Client joined chat: ${data}`);
                    io.of('chat').to(session_id.toString()).emit('joined', data);
                    let chat = chats.get(session_id);
                    chat.sockets[socket.id] = client_id;
                }
            });
        }
    });

    socket.on('disconnect', function(reason) {
        // find which session this socket is in
        for (c of chats) {
            let session_id = c[0];
            let chat = c[1];
            if (socket.id in chat.sockets) {
                // remove socket->client mapping
                logger.info(`Client disconnected from chat: ${chat.sockets[socket.id]}`);
                delete chat.sockets[socket.id];
                // remove chat session if empty
                if (Object.keys(chat.sockets).length <= 0) {
                    logger.info(`Chat session is empty, removing: ${session_id}`);
                    delete chat;
                }
            }
        }
    });

    // client audio processing
    socket.on('mic', function(data) {
        let session_id = data.session_id;
        let client_id = data.client_id;

        if (session_id && client_id) {
            // write to disk if recording
            let session = sessions.get(session_id);
            if (session) {
                // speech-to-text
                try {
                    processSpeech(data.blob, session_id, client_id, data.client_name);
                } catch (error) {
                    logger.error(`Error resampling mic data - client: ${client_id}, session: ${session_id}, error: ${error}`);
                }

                if (session.isRecording) {
                    let dir = `${CAPTURE_PATH}/${session_id}/${session.recordingStart}/audio/${client_id}`;
                    if (!fs.existsSync(dir)) {
                        fs.mkdirSync(dir, { recursive: true }, (err) => {
                            if(err) logger.warn(`Error creating capture audio directory: ${err}`);
                        });
                    }
                    let path = `${dir}/${session.seq}.wav`
                    fs.writeFile(path, data.blob, (err) => {
                        if (err) console.log('error writing audio file:', err)
                    });
                }
            }
        }
    });
});

// speech-to-text
// docs: https://docs.microsoft.com/en-us/azure/cognitive-services/speech-service/speech-to-text

const subscriptionKey = config.azure.subscriptionKey;
const serviceRegion = config.azure.serviceRegion; // e.g., "westus"

let processSpeech = function (audioBuffer, session_id, client_id, client_name) {
    // create the push stream we need for the speech sdk.
    var pushStream = sdk.AudioInputStream.createPushStream();

    // open the file and push it to the push stream.
    pushStream.write(audioBuffer);
    pushStream.close();

    // now create the audio-config pointing to our stream and
    // the speech config specifying the language.
    var audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
    var speechConfig = sdk.SpeechConfig.fromSubscription(subscriptionKey, serviceRegion);

    // setting the recognition language to English.
    speechConfig.speechRecognitionLanguage = "en-US";

    // create the speech recognizer.
    var recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

    // start the recognizer and wait for a result.
    recognizer.recognizeOnceAsync(
        function (result) {
            if (result.privText) {
                io.of('chat').to(session_id.toString()).emit('micText', { 
                    ts: Date.now(), 
                    session_id: session_id, 
                    client_id: client_id,
                    client_name: client_name,
                    text: result.privText, 
                    type: "speech-to-text" 
                });
                let session = sessions.get(session_id);
                if (session) {
                    if (session.isRecording)
                    {
                        let sttObj = {
                            ts: Date.now(),
                            session_id: session_id,
                            client_id: client_id,
                            text: result.privText
                        }
                        let path = getCapturePath(session_id, session.recordingStart, 'stt');
                        let wstream = fs.createWriteStream(path, { flags: 'a' })
                        wstream.write(JSON.stringify(sttObj)+'\n');
                        wstream.close();
                    }
                }
            }
            try {
                recognizer.close();            
            } catch (error) {
                logger.error(`Error closing SpeechRecognizer: ${error}`);
            }
        },
        function(err) {
            logger.error(`Error recognizing speech-to-text: ${err}`);
            try {
                recognizer.close();
            } catch (error) {
                logger.error(`Error closing SpeechRecognizer: ${error}`);
            }
        }
    );
}

// start server
const PORT = 3000;
server.listen(PORT, hostname = '0.0.0.0', function(){});

// peerjs server and handlers
const peerServer = ExpressPeerServer(server);
peerServer.on('connection', (client) => {
    logger.info(`PeerJS connection: ${client.id}`);
});
app.use('/call', peerServer)
logger.info(`Komodo relay is running on :${PORT}`);
