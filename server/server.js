const fs = require('fs');
const path = require('path');
const net = require('net');
const custom_console = require('./custom_console');
let log = custom_console.log;

const Receiver = require('./receiver');
const Sender = require('./sender');
const tokens = require('./tokens');
const packets = require('./packets');

var settings = JSON.parse(fs.readFileSync('settings.json'));
var banlist = JSON.parse(fs.readFileSync('banlist.json'));
var mutelist = JSON.parse(fs.readFileSync('mutelist.json'));


const server = net.createServer();


players = {} // Holds sockets that have gotten to the lobby
playersPending = {} // Holds players that need to be registered to other clients
id = 0; // Increasing number that is used to assing IDs to players.
autoplayer = true;
team = 0;

RedScore = 0;
RedAccuracy = 0;
RedMiss = 0;
RedMember = 0;

BlueScore = 0;
BlueAccuracy = 0;
BlueMiss = 0;
BlueMember = 0;

BiggerTeam = 0;
ServerAccuracy = 0;

const STATES = {
	'LOBBY': 0,
	'PREPARING': 1,
	'PLAYING': 2,
};
state = STATES.LOBBY;

in_game_count = 0;

song = "";
folder = "";
songLists = "";
listVersion = 0;
blockedFiles = ['picospeaker.json','dialogue-end.json','dialogue.json','_meta.json','meta.json','config.json','events.json'];

voices_packet = null;
inst_packet = null;
chart_packet = null;
voting = false; // WIll be used eventially
voteList = [];

function create_player(socket, nickname){
	var player = {
		'socket': socket,
		'id': id,
		'nickname': nickname,
		'ready': false,
		'alive': true,
		'last_chat': 0,
		'muted': mutelist.includes(socket.remoteAddress),
		'team': team,
		'invert': false,
		'score': 0,
		'miss': 0,
		'accuracy': 0.0
	};
	socket.player = player;
	players[id] = player;
	player.supported = false;
	id++;
	team++;
	if(team > 1)
		team = 0;
	
	player.broadcast = function(buffer){
		// Send message to all players but this one.
		for (let p of Object.values(players)){
			if (p.id != player.id){
				p.socket.write(buffer);
			}
		}
	}
	
	
	player.broadcastSupported = function(buffer){
		// Send message to all players but this one.
		for (let p of Object.values(players)){
			if (p.id != player.id && p.supported){
				p.socket.write(buffer);
			}
		}
	}
	player.broadcastUnsupported = function(buffer){
		// Send message to all players but this one.
		for (let p of Object.values(players)){
			if (p.id != player.id && !p.supported){
				p.socket.write(buffer);
			}
		}
	}
	
	player.destroy = function(destroy_socket=true){
		player.broadcast(Sender.CreatePacket(packets.PLAYER_LEFT, [player.id]));
			
		// If the only player that's yet to be ready leaves the server, start the game (or end it if this was the only player at all).
		if (in_game_count == Object.keys(players).length - 1 && !player.ready && state == STATES.PREPARING){
			if (in_game_count > 0)
				start_game();
			else
				end_game();
		}
			
		if (player.ready){
			in_game_count--;
				
			if (state == STATES.PLAYING){
				// If the last player leaves, end the game.
				if (in_game_count == 0){
					end_game();
				}
			}
		}
		
		// Delete the socket
		if (player.socket && destroy_socket){
			player.socket.end(Sender.CreatePacket(packets.DISCONNECT, []), () => {player.socket.destroy()});
		}
		if (playersPending[player.id]){delete playersPending[player.id];}
		// Remove the player object.
		custom_console.log(`${player.nickname}(${player.id}) left`);

		delete players[player.id];
		
		if (state == STATES.PREPARING)
			broadcast(Sender.CreatePacket(packets.PLAYERS_READY, [in_game_count]));

	}
	
	return player;
}

function broadcast(buffer){
	// Send message to all players.
	for (let p of Object.values(players)){
		p.socket.write(buffer);
	}
}
function broadcastSupported(buffer){
	// Send message to all players.
	for (let p of Object.values(players)){
		if (p.supported){p.socket.write(buffer);}
		
	}
}
function broadcastUnsupported(buffer){
	// Send message to all players.
	for (let p of Object.values(players)){
		if (!p.supported){p.socket.write(buffer);}
		
	}
}

// Keep-Alive packets
function keep_alive(){
	for (let p of Object.values(players)){
		// Loading the songs can take a while, and the client can't respond to keep-alives during that time.
		if (state == STATES.PREPARING && !p.ready)
			continue;
		// If the player hasn't responded to the keep-alive, destroy the connection.
		if (!p.alive)
			p.destroy();
		else
			p.alive = false;
	}
	// Send a new keep-alive packet
	broadcast(Sender.CreatePacket(packets.KEEP_ALIVE, []));
	
	setTimeout(keep_alive, settings.keep_alive);
}
keep_alive();

server.on('connection', function (socket) {
	var receiver = new Receiver(socket);
	if (banlist.includes(socket.remoteAddress))
		socket.destroy();
	
	receiver.on('data', function (packetId, data) {
		var socket = receiver.socket;
		var player = socket.player;
		if (!player) log(`A client without a player is sending a packet ${packetId}`);

		// if(player) custom_console.log(`Got ${packetId} / ${data} from ${player.nickname}`);
		switch (packetId){
			// Setup
			case packets.SEND_CLIENT_TOKEN:
				var token = data[0];
				if (token == tokens.clientToken){ // Client's & server's tokens match
					socket.write(Sender.CreatePacket(packets.SEND_SERVER_TOKEN, [tokens.serverToken]));
					socket.verified = true;
				}else // Client's & server's tokens don't match
					socket.destroy()
				break;
			case packets.SEND_PASSWORD:
				var pwd = data[0];
				
				if (socket.verified && (pwd == settings.adminpass || pwd == settings.password || settings.password == '')){
					if (Object.keys(players).length >= settings.max_players){
						socket.write(Sender.CreatePacket(packets.PASSWORD_CONFIRM, [3])); // Game already full
						socket.destroy();
						break;
					}
					// else if (state != STATES.LOBBY){
					// 	socket.write(Sender.CreatePacket(packets.PASSWORD_CONFIRM, [1])); // Game already in progress
					// 	socket.destroy();
					// 	break;
					// }
					if (pwd == settings.adminpass){
						socket.admin = true;
					}
					// Authorized
					socket.authorized = true;
					socket.write(Sender.CreatePacket(packets.PASSWORD_CONFIRM, [0]));
				}else{
					socket.write(Sender.CreatePacket(packets.PASSWORD_CONFIRM, [4])); // Wrong password
					socket.destroy();
				}
				break;
			
			// Nickname / Lobby
			case packets.SEND_NICKNAME:
				if (socket.authorized){
					var nick = data[0];
					
					
					if (nick == '' || /[^A-Za-z0-9.-]/.test(nick) || nick.length > 12){
						socket.write(Sender.CreatePacket(packets.NICKNAME_CONFIRM, [3])); // Invalid nickname
						break;
					}
					
					if (Object.keys(players).length >= settings.max_players){
						socket.write(Sender.CreatePacket(packets.NICKNAME_CONFIRM, [4])); // Game already full
						socket.destroy();
						break;
					}
					
					for (p of Object.values(players)){
						if (p.nickname == nick){
							socket.write(Sender.CreatePacket(packets.NICKNAME_CONFIRM, [1])); // Nickname already claimed
							return;
						}
					}
					
					// if (state != STATES.LOBBY){
					// 	socket.write(Sender.CreatePacket(packets.NICKNAME_CONFIRM, [2])); // Game already in progress
					// 	break;
					// }
					
					// Nickname accepted
					socket.nickname = nick;
					socket.write(Sender.CreatePacket(packets.NICKNAME_CONFIRM, [0]));
					break;
				}
				break;
			case packets.KEEP_ALIVE: // KEEP_ALIVE packet can be sent by server and client
				if (player)
					player.alive = true;
				break;
			case packets.JOINED_LOBBY:
				if (socket.nickname){
					// Create player object for this player
					player = create_player(socket, socket.nickname);
					delete socket['nickname'];

					
					// Tell all players that this new player joined.
					player.broadcast(Sender.CreatePacket(packets.BROADCAST_NEW_PLAYER, [player.id, player.nickname]));
					// Tell this new player all the players that are already joined.
					for (let p of Object.values(players)){
						if (p.id != player.id){
							socket.write(Sender.CreatePacket(packets.BROADCAST_NEW_PLAYER, [p.id, p.nickname]));
						}
					}
					if (state != STATES.LOBBY){
						playersPending[player.id] = player;
						player.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE, [`A match of ${song} is currently going on, You can wait here until the next one.`]));
					}
					if (socket.admin){
						player.admin=true;
						log(`${player.nickname} registered as an admin!`);
						player.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE, ["You are an admin! Do !help for help."]));
					}
					player.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE, ["You are on " + (player.team == 0 ? "Blue" : "Red") + " Team"]));
					log(`${player.nickname} Joined on `+ (player.team == 0 ? "Blue!" : "Red!"))
					player.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE, ["'ceabf544' This is a compatibility message, Ignore me!"])); // Check for support for misses and such
					// This is used so that the player knows when the previous players are done being sent, and it knows it's own position in the list.
					socket.write(Sender.CreatePacket(packets.END_PREV_PLAYERS, []));
				}
				break;
			

			// Gaming
			case packets.GAME_READY:
				for (let p of Object.values(players))
					p.score = 0;
				RedScore = 0;
				RedMiss = 0;
				RedAccuracy = 0;
				RedMember = 0;
				BlueScore = 0;
				BlueMiss = 0;
				BlueAccuracy = 0;
				BlueMember = 0;
				if (player && !player.ready && state == STATES.PREPARING){
					player.ready = true;
					in_game_count++;
					
					// Tell everyone how many players are ready, for the "Waiting for players..." screen.
					broadcast(Sender.CreatePacket(packets.PLAYERS_READY, [in_game_count]));
					
					if (in_game_count == Object.keys(players).length){
						// When all players are ready
						start_game();
					}else if (in_game_count == 1){
						
						setTimeout(function() {
							// This code is dangerously close to terrible.
							// In practice, it's unlikely to cause issues.
							if (state == STATES.PREPARING){
								for (let p of Object.values(players)){
									if (!p.ready)
										p.destroy();
								}
								
								start_game();
							}
						}, settings.wait);
						
					}
				}
				break;
			case packets.SEND_SCORE:
				if (player && state == STATES.PLAYING){
					var score = data[0];
					player.score = data[0];
					// Broadcast score. Yeah, there's no server-side verification, too lazy to implement it... :/
					player.broadcast(Sender.CreatePacket(packets.BROADCAST_SCORE, [player.id, score]));
				}
				break;
			case packets.SEND_CURRENT_INFO:
				if (player && state == STATES.PLAYING){
					var score = data[0];
					var misses = data[1];
					var accuracy = data[2];
					player.score = score;
					player.miss = misses;
					player.accuracy = (accuracy > 100 ? accuracy / 100 : accuracy);
					// Broadcast score. Yeah, there's no server-side verification, too lazy to implement it... :/

					player.broadcastUnsupported(Sender.CreatePacket(packets.BROADCAST_SCORE, [player.id, score]));
					player.broadcastSupported(Sender.CreatePacket(packets.BROADCAST_CURRENT_INFO, [player.id, score,misses,accuracy]));
				}
				break;
			case packets.KEYPRESSED:
				var valid = true;
				if (data.length > 4) valid = false;
				if (!valid){
					custom_console.log(`${player.id}'s inputs are invalid, not sending!`)
					broadcastSupported(Sender.CreatePacket(packets.KEYPRESSED,data));
					broadcastSupported(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' set syncInput false `]));
					break;
				}
				if (settings.sync_players){
					if(autoplayer)data[2] = player.id * 100;
					player.broadcastSupported(Sender.CreatePacket(packets.KEYPRESSED,[data[0],data[1],data[2],data[3]]));
				}
				break;
			case packets.GAME_END:
				if (player && player.ready && state == STATES.PLAYING){
					in_game_count--;
					player.ready = false;
					if (in_game_count == 0){
						end_game();
						for (let p of Object.values(players)){
							if(p.team == 0 && p.score != 0)
							{
								BlueScore += p.score;
								BlueAccuracy += p.accuracy;
								BlueMiss += p.miss;
								BlueMember += 1;
							}
							else if (p.score != 0)
							{
								RedScore += p.score;
								RedAccuracy += p.accuracy;
								RedMiss += p.miss;
								RedMember += 1;
							}
						}
						BiggerTeam = Math.max(BlueMember,RedMember);
						BlueScore = Math.round(BlueScore * (BiggerTeam / BlueMember));
						RedScore = Math.round(RedScore * (BiggerTeam / RedMember));
						BlueAccuracy = Math.round((BlueAccuracy / BlueMember) * 100) / 100;
						RedAccuracy = Math.round((RedAccuracy / RedMember) * 100) / 100;
						ServerAccuracy = Math.round(((BlueAccuracy + RedAccuracy) / 2) * 100) / 100;
						player.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE, [`Server Score : ${BlueScore + RedScore} Miss : ${BlueMiss + RedMiss} Accuracy : ${ServerAccuracy}`]));
						if(BlueMember == 0 || RedMember == 0)
							break;
						player.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE, [`Blue Score : ${BlueScore} Miss : ${BlueMiss} Accuracy : ${BlueAccuracy}`]));
						player.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE, [`Red Score : ${RedScore} Miss : ${RedMiss} Accuracy : ${RedAccuracy}`]));
					}
				}
				break;
			
			// Chat
			case packets.SEND_CHAT_MESSAGE:
				if (player){
					var id = data[0];
					var message = data[1];
					
					if (player.muted){
						player.socket.write(Sender.CreatePacket(packets.MUTED, []));
						return;
					}
					
					if (message.length > 0 && message[0] != ' ' && (message.length <= 80 || player.admin)){
						custom_console.log(`${player.nickname} : ${message}`)
						if (message.startsWith('/')){
							commandHandle(message.substring(1),player)
							return;
						}else if (message.startsWith('!') && player.admin){
							custom_console.handle(message.substring(1),player)
							return;
						}else if (Date.now() - player.last_chat > settings.chat_speed){
							player.broadcast(Sender.CreatePacket(packets.BROADCAST_CHAT_MESSAGE, [player.id, message]));
							player.last_chat = Date.now();
							return;
						}
					}
					
					// Reject the message
					player.socket.write(Sender.CreatePacket(packets.REJECT_CHAT_MESSAAGE, [id]));
				}
				break;
			
			// Download
			case packets.READY_DOWNLOAD:
				if (player && state == STATES.PREPARING)
					socket.write(chart_packet);
				break;
			case packets.REQUEST_VOICES:
				if (player && (state == STATES.PREPARING || state == STATES.LOBBY)){
					log(player.nickname + " Request Voice");
					if (voices_packet)
						socket.write(voices_packet);
					else{
						socket.write(Sender.CreatePacket(packets.DENY, []));
						// Give the client time to see the DENY packet
						if(state == STATES.PREPARING)
							setTimeout(function() {player.destroy();}, 1000);
					}
				}
				break;
			case packets.REQUEST_INST:
				if (player && (state == STATES.PREPARING || state == STATES.LOBBY)){
					log(player.nickname + " Request Inst");
					if (inst_packet)
						socket.write(inst_packet);
					else{
						socket.write(Sender.CreatePacket(packets.DENY, []));
						// Give the client time to see the DENY packet
						if(state == STATES.PREPARING)
							setTimeout(function() {player.destroy();}, 1000);
					}
				}
				break;
			case packets.SUPPORTED:
				if (player){
					player.supported = true
					if(settings.allow_client_scripts)
					send(player,["'32d5d167' set clientscript true"])
				}
				break;
			case packets.CUSTOMPACKETSTRING:
				if(player){
					switch(data[0]){ // WHY THE FUCK DO I NEED BREAK ON EVERY END OF CASE
						case "pingCheck":
							player.socket.write(Sender.CreatePacket(packets.CUSTOMPACKETSTRING,['pingCheck','pong!']));
							break;
						case "REQUEST_SongFolder":
							player.socket.write(Sender.CreatePacket(packets.CUSTOMPACKETSTRING,['SetFolder',`${folder} ${song}`]));
							break;
						case "REQUEST_SongName":
							if(folder !== "" && song !== "")
								player.socket.write(Sender.CreatePacket(packets.CUSTOMPACKETSTRING,['SetSong',`${folder} ${song}`]));
							break;
						case "REQUEST_listVersion":
							player.socket.write(Sender.CreatePacket(packets.CUSTOMPACKETINT,['listVersion',listVersion]));
							break;
						case "REQUEST_SongLists":
							player.socket.write(Sender.CreatePacket(packets.CUSTOMPACKETSTRING,['Song',songLists]));
							break;
						case "Set_Status":
							player.broadcast(Sender.CreatePacket(packets.CUSTOMPACKETSTRING,['Set_Status',`${player.id}/*/${data[1]}`]));
							break;
						default:
							player.broadcast(Sender.CreatePacket(packets.CUSTOMPACKETSTRING, [data[0], data[1]]));
							break;
					}
				}
				break;
			case packets.CUSTOMPACKETINT:
				if(player){
					player.broadcast(Sender.CreatePacket(packets.CUSTOMPACKETINT, [data[0], data[1]]));
				}
				break;
			// Error
			default:
				custom_console.log(`Invalid packet ${packetId} from ${player.id}`)
				socket.destroy();
				break;
		}
	});
	
	receiver.on('connection', function (packetId) {
		log("Ay, a connection!");
	});

	function client_leave(){
		var player = socket.player;
		
		if (player && player.id in players){
			player.destroy(false);
		}
	}
	
	
	socket.on('error', function(e) {
		client_leave();
		socket.destroy();
	});
	
	
	socket.on('end', function () {
		client_leave();
	});
	
	socket.on('close', function() {
		client_leave();
	});
});

function start_game(){
	if (state == STATES.PREPARING){
		state = STATES.PLAYING;
		broadcast(Sender.CreatePacket(packets.EVERYONE_READY, [settings.safe_frames]));
	}
}

function end_game(){
	state = STATES.LOBBY;
	for (pl of Object.values(players)){
		
		if (!playersPending[pl.id] && pl.ready){
		let playersJoined = "";
		for (let p of Object.values(playersPending)){
			if (p.id != pl.id){
				log(`${pl.nickname} Doesn't know about ${p.nickname}. Telling them they exist!`);
				pl.socket.write(Sender.CreatePacket(packets.BROADCAST_NEW_PLAYER, [p.id, p.nickname]));
				playersJoined = `${playersJoined} ${p.nickname}`
			}
		}
		if (playersJoined != ""){ // Message notifying player about other players joining
			pl.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`${playersJoined}`]));
			pl.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`joined while you where playing, if none of them appear, Please rejoin`]));
		}
		}
		pl.ready = false;
	}
	playersPending = {}
	in_game_count = 0;
	log("Game finished");
}


server.on('listening', function () {
	songLists = "";
	const files = fs.readdirSync('data/');
	files.forEach(function(file) {
		if (fs.lstatSync(path.join('data/', file)).isDirectory()) {
			const folderName = path.basename(file);
			const subFiles = fs.readdirSync(path.join('data/', file));
			subFiles.forEach(function(subFile) {
				if (path.extname(subFile) === '.json' && !blockedFiles.includes(subFile)) {
				const chartName = path.basename(subFile, '.json');
				songLists += `${chartName},${folderName} `;
			}
		});
		}
	});
	listVersion++;
	log("SongLists have been cached");
	log("Server started on port " + PORT);
});


server.maxConnections = 256;

const PORT = process.env.PORT || settings.port;
server.listen(PORT);

function send(p,args,packetType){
	if(packetType == null){
		packetType = packets.SERVER_CHAT_MESSAGE;
	}
	p.socket.write(Sender.CreatePacket(packetType,args))
	log(`Sent Packet ${packetType} with ${args} to ${p.id}`)
}
// Console commands stuff below
// I would have loved to include this in a different file but I couldn't find an elegant approach
// Globals vars are not elegant

const commands = {
	"start": "Start the game",
	"setsong": "Set the song to be played - takes folder and filename as arguments",
	"randsong": "Selects a random song - Takes 'hard','h','e','easy' as arguments for mode",
	"listsongs": "Lists all valid songs- Takes 'hard','h','e','easy' as arguments for mode",
	"count": "Count the number of players online, and number or players that are ready",
	"list": "Display a list of IDs and player names",
	"enable_vote": "Enables voting - Takes 'hard','h','e','easy' as arguments for mode...\n and a count for song count",
	"disable_vote": "Disables voting",
	"invert": "Inverts the chart for a specific player, takes a name and a bool",
	"script": "turn client script on or off",
	"input": "turn input sync on or off",
	"op": "give player admin permission temporary until they left the server",
	"deop": "take away player admin permission",

	"speed": "change Song Speed SE-T Only",
	"mania": "Force Mania SE-T Only",
	"randomnote": "Random Note Placement Useful for Force Mania SE-T Only",
	"charid": "Set Player CharID SE-T Only",
	"coop": "Set Player CO-OP Mode SE-T Only",
	"addchar": "Add Character SE-T Only",
	"clearchar": "Clear Character SE-T Only",
	"autoplayer": "Toggle Player SE-T Only",

	"sendhscript": "yes",
	"set": "Change settings for a specific player, takes a name, the setting, and the value",
	"get": "Get Info from player",
	"setteam": "Set Team",
	"sendraw": "Send raw commands to a specific player, takes a name, and the command",

	"force_start": "Forces the game to start. Any player that isn't ready will be disconnected from the server",
	"force_end": "Forces the game to end. All players will be sent back to the lobby",
	
	"kick": "Kick a player from the game",
	"ban": "Ban a player from the game",
	"mute": "Prevent a player from talking",
	"unmute": "Let a player talk again",
	
	"say": "Say something in the chat",
	
	"reload": "Reloads the settings file",
	
	"cls": "Clears the console",
	
	"exit": "Close the server"
};
const allCommands = {
	"vote":"Vote for a song if voting is active"
};

var getRandomSong = function(modein){
	
	let songList = fs.readdirSync('data/');
	if(!songList){custom_console.log('Something went wrong trying to query /data!');return;}
	let song;
	let mode = "";
	if(modein == 1){mode="-hard"}else if(modein ==-1){mode='-easy'}
	let loops = 0;
	do{
		let tempsong = songList[Math.floor(Math.random()*songList.length)]
		if (fs.statSync(`data/${tempsong}`).isDirectory()){
			if (fs.existsSync(`data/${tempsong}/${tempsong}${mode}.json`)){
				song={"song":tempsong,"json":`${tempsong}${mode}`};
			}else{custom_console.log(`${tempsong} doesn't have a ${tempsong}${mode}.json, You might want to fix this!`);}
		}
	}while(!song)
	return song
}
var createVote = function(mode,count){
	voteList =[];
	if (!count){count=3;}
	for (var i = count; i >= 0; i--) {
		let songset = false;
		while(!songset){
			let cursong = getRandomSong(mode);
			if (cursong && !(cursong in voteList)){voteList.push(cursong);songset=true;}
		}
		
	}
	broadcastVotelist()
}
var broadcastVotelist = function(player){
	if(!voting){
		if(log){
			log("Voting is not enabled!");
		}else{
			custom_console.log("Tried to broadcast voteList when voting is not in session!");
		}
		return;}
	let rep = broadcast;
	if(player){
		rep=function(message){player.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[message]));}
	}
	rep("-----Vote list-----");
	for (var i = 0; i < voteList.length; i++) {
		rep(`${i} - ${voteList[i].songjson}`);
	}
	rep("-------------------");
	rep("Use '/vote (ID)' to vote for a song");
}

var commandHandle = function (input,player){

	var separated = input.split(" ");
	var command = separated[0]
	var args = separated.slice(1);
	var reply=function(message){ // Directs all messages to player and seperates into seperate messages for line breaks
				custom_console.log(message)
				var sep =message.split('\n'); 
				for (var i = sep.length - 1; i >= 0; i--) {
					player.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`${sep[i]}`]));
				}

				
			}
	if (command == "help"){
		var help_string = "";
		for (const [cmd, desc] of Object.entries(allCommands)){
			help_string += cmd + ": " + desc + "\n";
		}
		log(help_string.substr(0, help_string.length - 1));
		return;
	}
	separated = input.split(" ");
	command = separated[0];
	args = separated.slice(1);
	if (command in allCommands){
		switch (command){
			case "vote":
				reply('Unfinished');
				// if (voting){

				// }else{
				// 	reply("Voting is not enabled at the moment!")
				// }
		}
	}else{
		reply("Couldn't recognize command '" + command + "'. Try using 'help'");
	}
}
var setSong = function(file,fold){
	if (!file){
		log('No song to search for. File, Folder')
		return;
	}
	var _folder = fold;
	if (!fold) {
		_folder = `${file.match(/([A-z0-9_\-]+)(?=-)/g)}`
		if (!_folder || _folder == "" || _folder == "null"){_folder=file}
		if (!fs.existsSync(`data/${_folder}/${_folder}.json`)) {log(`Couldn't find 'data/${_folder}/${file}.json'\nTry manually specifying file,folder`); return;}
	}
	if (!fs.existsSync(`data/${_folder}/${file}.json`)) {log(`Couldn't find 'data/${_folder}/${file}.json'`); return;}
	song = file;
	folder = _folder;
	let audio = fs.existsSync(`data/${folder}/Voices.ogg`) || fs.existsSync(`data/${folder}/Inst.ogg`);
	
	log("Set song to " + folder + "/" + song + ". " + (audio ? ("Found audio files at data/" + folder) : ("Did not find audio files at data/" + folder)) + ".");
	broadcast(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`Song was set to ${song}`]));
	broadcast(Sender.CreatePacket(packets.CUSTOMPACKETSTRING,['SetSong',`${folder} ${song}`]));
	// Load the voices & inst from file
	// If they don't exist, a DENY packet will be sent when a player requests them
	let voices_path = 'data/' + folder + '/Voices.ogg';
	let inst_path = 'data/' + folder + '/Inst.ogg';
	voices_packet = null;
	if (fs.existsSync(voices_path))
		voices_packet = Sender.CreatePacket(packets.SEND_VOICES, [fs.readFileSync(voices_path)]);
	inst_packet = null;
	if (fs.existsSync(inst_path))
		inst_packet = Sender.CreatePacket(packets.SEND_INST, [fs.readFileSync(inst_path)]);
	return;
}

custom_console.handle = function (input,player){
	var separated = input.split(" ");
	var command = separated[0]
	var args = separated.slice(1);
	let log = custom_console.log;
	if (command == '') return;
	if (player){log=function(message){ // Redefines log if player executed a command, Redirects all messages to player and seperates into seperate messages for line breaks
			custom_console.log(message)
			var sep =message.split('\n'); 
			for (var i = sep.length - 1; i >= 0; i--) {
				player.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`${sep[i]}`]));
			}

			
		}	
	}
	if (command == "help"){
		var help_string = "";
		for (const [cmd, desc] of Object.entries(commands)){
			help_string += cmd + ": " + desc + "\n";
		}
		log(help_string.substr(0, help_string.length - 1));
		return;
	}
	separated = input.split(" ");
	command = separated[0];
	args = separated.slice(1);
	if (command in commands){
		switch (command){
			case "start":
				if (state == STATES.LOBBY){
					if (!fs.existsSync(`data/${folder}/${song}.json`)){
						log("Invalid song");
						return;
					}
					
					if (Object.keys(players).length == 0){
						log("No players joined");
						return;
					}
					if (Object.keys(players).length == 2 && settings.auto_swap_sides){
						var invertnotes = false; 
						for (let p of Object.values(players)){
							p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' set invertnotes ${invertnotes}`]))
							invertnotes = !invertnotes;
						}
					}else if (Object.keys(players).length >= 2 && settings.auto_swap_sides){
						broadcastSupported(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,["'32d5d167' set invertnotes false"]));
					}

					log(`Starting game with ${folder}/${song}`);
					
					// Load the chart from file
					chart = fs.readFileSync('data/' + folder + '/' + song + '.json');
					let i = chart.length - 1;
					while (chart.readUInt8(i) != 125){
						i--;
						// "LOL GOING THROUGH THE BULLSHIT TO CLEAN IDK WHATS STRANGE" - ninjamuffin99
					}
					chart = chart.slice(0, i + 1);

					let song_name = JSON.parse(chart).song.song.toLowerCase();
					
					chart_packet = Sender.CreatePacket(packets.SEND_CHART, [chart]);
					
					let script_path = 'data/' + folder + '/script.hscript';
					
					// try send script hope it just work
					if(fs.existsSync(script_path))
						broadcast(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' sendhscript temp-${song_name} ${fs.readFileSync(script_path)}`]));
					
					// Tell all players that the game is starting
					broadcast(Sender.CreatePacket(packets.GAME_START, [song, folder]));
					state = STATES.PREPARING;
				}else{
					log("Game already in progress");
				}
				break;
			case "randsong":
				var mode = 0;
				if(args[0]){if (args[0] == 'hard' || args[0] == 'h'){mode=1;}else if (args[0] == 'easy' || args[0] == 'e'){mode=-1;}}
				let tempSong = getRandomSong(mode);
				if (!tempSong?.song){log("Unable to get a song!");return;}
				setSong(tempSong.json,tempSong.song)
				break;
			case "listsongs":
				var mode = "";
				if(args[0]){if (args[0] == 'hard' || args[0] == 'h'){mode="-hard";}else if (args[0] == 'easy' || args[0] == 'e'){mode='-easy';}}
				var songlist = fs.readdirSync('data/');
				log("----Song List----");
				for (var i = songlist.length - 1; i >= 0; i--) {
					if (fs.statSync(`data/${songlist[i]}`).isDirectory()){
						if (fs.existsSync(`data/${songlist[i]}/${songlist[i]}${mode}.json`)){
							log(`- ${songlist[i]}${mode}`);
						}
					}
				}
				log("----------------");
				break;
			case "setsong":
				if (!args[0]){
					log('No song to search for. File, Folder')
					return;
				}
				setSong(args[0],args[1]);
				break;
			case "count":
				log("Players: " + Object.keys(players).length + "\nReady Count: " + in_game_count);
				break;
			case "list":
				if (Object.keys(players).length == 0) {log("No players"); break;}
				var output = "";
				BlueMember = 0;
				RedMember = 0;
				for (p of Object.values(players)){
					output += p.id + ": " + p.nickname + " On Team " + (p.team == 0 ? "Blue" : "Red") + "\n";
					if(p.team == 0)
						BlueMember += 1;
					else
						RedMember += 1;
				}
				if(BlueMember == 0 || RedMember == 0){
					log(`One of the Team is Empty\n` + output.substr(0, output.length - 1));
					break;
				}
				BiggerTeam = Math.max(BlueMember,RedMember);
				log((BlueMember == RedMember ? `The Team is balanced` : BlueMember < RedMember ? `Blue Team will get ${Math.round((BiggerTeam / BlueMember) * 100) / 100} Score Multiplier` : `Red Team will get ${Math.round((BiggerTeam / RedMember) * 100) / 100} Score Multiplier`) + `\n` + output.substr(0, output.length - 1));
				break;
			case "enablevote":
				return log('This command is disabled!');
				if(voting){
					if(player){
						log("Voting is already enabled, Do '/votelist' to get the current song list.");
					}else{
						log("Voting is already enabled.");
					}
					return;
				}
				voting = true;
				var mode = 0;
				if(args[0]){if (args[0] == 'hard' || args[0] == 'h'){mode=1;}else if (args[0] == 'easy' || args[0] == 'e'){mode=-1;}}
				createVote(mode);
				break;
			case "disablevote":
				if(!voting){return log("Voting is already disabled!");}
				voting = false;
				votingList = [];
				break;		

			case "force_start":
				if (state == STATES.PREPARING){
					for (let p of Object.values(players)){
						if (!p.ready)
							p.destroy()
					}
					
					// start_game();
					log("Forcing start");
				}else if (state == STATES.LOBBY){
					log("No game in progress");
				}else if (state == STATES.PLAYING){
					log("Game already in progress");
				}
				break;
			case "force_end":
				if (state == STATES.PLAYING || state == STATES.PREPARING){
					broadcast(Sender.CreatePacket(packets.FORCE_GAME_END, []));
					end_game();
				}else{
					log("No game in progress");
				}
				break;
			
			case "kick":
				if (args.length < 1) {log("Expected 1 argument: nickname"); break;};
				
				for (let p of Object.values(players)){
					if (p.nickname == args[0]){
						log("Kicked '" + p.nickname + "' from the game");
						p.destroy();
						return;
					}
				}
				
				log("Couldn't find player '" + args[0] + "'");
				
				break;
			case "invert":
				if (args.length < 2) {log("Expected 2 arguments: nickname,bool"); break;};
				
				for (let p of Object.values(players)){
					if (p.nickname == args[0]){
						p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' set invertnotes ${args[1]}`]));
						p.invert = args[1];
						log(`set invert charts of ${args[0]} to ${args[1]}`);
						return;
					}
					else if (args[0] == "@a"){
						p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' set invertnotes ${args[1]}`]));
						p.invert = args[1];
					}
					else if (args[0] == "@s" && p.nickname == player.nickname){
						p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' set invertnotes ${args[1]}`]));
						p.invert = args[1];
						log(`set invert charts of ${player.nickname} to ${args[1]}`);
						return;
					}
				}
				if (args[0] == "@a"){
					log(`set invert charts for everyone to ${args[1]}`);
					return;
				}
				
				log("Couldn't find player '" + args[0] + "'");
				
				break;
			case "script":
				if (args.length < 2) {log("Expected 2 arguments: nickname,bool"); break;};
				
				for (let p of Object.values(players)){
					if (p.nickname == args[0]){
						p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' set clientscript ${args[1]}`]));
						log(`set client script of ${args[0]} to ${args[1]}`);
						return;
					}
					else if (args[0] == "@a")
					p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' set clientscript ${args[1]}`]));
					else if (args[0] == "@s" && p.nickname == player.nickname){
						p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' set clientscript ${args[1]}`]));
						log(`set client script of ${player.nickname} to ${args[1]}`);
						return;
					}
				}
				if (args[0] == "@a"){
					log(`set client script for everyone to ${args[1]}`);
					return;
				}
				
				log("Couldn't find player '" + args[0] + "'");
				
				break;
			case "input":
				if (args.length < 2) {log("Expected 2 arguments: nickname,bool"); break;};
				
				for (let p of Object.values(players)){
					if (p.nickname == args[0]){
						p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' set inputsync ${args[1]}`]));
						log(`set input sync of ${args[0]} to ${args[1]}`);
						return;
					}
					else if (args[0] == "@a")
						p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' set inputsync ${args[1]}`]));
					else if (args[0] == "@s" && p.nickname == player.nickname){
						p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' set inputsync ${args[1]}`]));
						log(`set input sync of ${player.nickname} to ${args[1]}`);
						return;
					}
				}
				if (args[0] == "@a"){
					log(`set input sync for everyone to ${args[1]}`);
					return;
				}
				
				log("Couldn't find player '" + args[0] + "'");
				
				break;
			case "speed":
				if (args.length < 2) {log("Expected 2 arguments: nickname,value"); break;};
				
				for (let p of Object.values(players)){
					if (p.nickname == args[0]){
						p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' set speed ${args[1]}`]));
						log(`set Song Speed of ${args[0]} to ${args[1]}`);
						return;
					}
					else if (args[0] == "@a")
						p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' set speed ${args[1]}`]));
					else if (args[0] == "@s" && p.nickname == player.nickname){
						p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' set speed ${args[1]}`]));
						log(`set Song Speed of ${player.nickname} to ${args[1]}`);
						return;
					}
				}
				if (args[0] == "@a"){
					log(`set Song Speed for everyone to ${args[1]}`);
					return;
				}
				
				log("Couldn't find player '" + args[0] + "'");
				
				break;
			case "mania":
				if (args.length < 2) {log("Expected 2 arguments: nickname,value"); break;};
				
				for (let p of Object.values(players)){
					if (p.nickname == args[0]){
						p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' set forcemania ${args[1]}`]));
						log(`set Force Mania of ${args[0]} to ${args[1]}`);
						return;
					}
					else if (args[0] == "@a")
						p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' set forcemania ${args[1]}`]));
					else if (args[0] == "@s" && p.nickname == player.nickname){
						p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' set forcemania ${args[1]}`]));
						log(`set Force Mania of ${player.nickname} to ${args[1]}`);
						return;
					}
				}
				if (args[0] == "@a"){
					log(`set Force Mania for everyone to ${args[1]}`);
					return;
				}
				
				log("Couldn't find player '" + args[0] + "'");
				
				break;
			case "randomnote":
				if (args.length < 2) {log("Expected 2 arguments: nickname,value"); break;};
				
				for (let p of Object.values(players)){
					if (p.nickname == args[0]){
						p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' set randomnote ${args[1]}`]));
						p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' set randomsection ${args[1]}`]));
						log(`set Random Note of ${args[0]} to ${args[1]}`);
						return;
					}
					else if (args[0] == "@a"){
						p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' set randomnote ${args[1]}`]));
						p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' set randomsection ${args[1]}`]));
					}
					else if (args[0] == "@s" && p.nickname == player.nickname){
						p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' set randomnote ${args[1]}`]));
						p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' set randomsection ${args[1]}`]));
						log(`set Random Note of ${player.nickname} to ${args[1]}`);
						return;
					}
				}
				if (args[0] == "@a"){
					log(`set Random Note for everyone to ${args[1]}`);
					return;
				}
				
				log("Couldn't find player '" + args[0] + "'");
				
				break;
			case "charid":
				if (args.length < 2) {log("Expected 2 arguments: nickname,value"); break;};
				
				for (let p of Object.values(players)){
					if (p.nickname == args[0]){
						p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' set charid ${args[1]}`]));
						log(`set Character ID of ${args[0]} to ${args[1]}`);
						return;
					}
					else if (args[0] == "@a"){
						p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' set charid ${args[1]}`]));
					}
					else if (args[0] == "@s" && p.nickname == player.nickname){
						p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' set charid ${args[1]}`]));
						log(`set Character ID of ${player.nickname} to ${args[1]}`);
						return;
					}
				}
				if (args[0] == "@a"){
					log(`set Character ID for everyone to ${args[1]}`);
					return;
				}
				
				log("Couldn't find player '" + args[0] + "'");
				
				break;
			case "coop":
				if (args.length < 2) {log("Expected 2 arguments: nickname,value"); break;};
				
				for (let p of Object.values(players)){
					if (p.nickname == args[0]){
						p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' set coop ${args[1]}`]));
						log(`set CO OP of ${args[0]} to ${args[1]}`);
						return;
					}
					else if (args[0] == "@a"){
						p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' set coop ${args[1]}`]));
					}
					else if (args[0] == "@s" && p.nickname == player.nickname){
						p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' set coop ${args[1]}`]));
						log(`set CO OP of ${player.nickname} to ${args[1]}`);
						return;
					}
				}
				if (args[0] == "@a"){
					log(`set CO OP for everyone to ${args[1]}`);
					return;
				}
				
				log("Couldn't find player '" + args[0] + "'");
				
				break;
			case "addchar":
				if (args.length < 3) {log("Expected 4 arguments: nickname,character,side,offset(optional)"); break;};
				
				for (let p of Object.values(players)){
					if (p.nickname == args[0]){
						p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' addchar ${args[1]} ${args[2]} ${args[3]}`]));
						log(`Add ${args[1]} on ${args[2]} with ${args[3]} offset for ${args[0]}`);
						return;
					}
					else if (args[0] == "@a"){
						p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' addchar ${args[1]} ${args[2]} ${args[3]}`]));
					}
					else if (args[0] == "@s" && p.nickname == player.nickname){
						p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' addchar ${args[1]} ${args[2]} ${args[3]}`]));
						log(`Add ${args[1]} on ${args[2]} with ${args[3]} offset for ${args[0]}`);
						return;
					}
				}
				if (args[0] == "@a"){
					log(`Add ${args[1]} on ${args[2]} with ${args[3]} offset for everyone`);
					return;
				}
				
				log("Couldn't find player '" + args[0] + "'");
				
				break;
			case "clearchar":
				if (args.length < 1) {log("Expected 1 argument: nickname"); break;};
				
				for (let p of Object.values(players)){
					if (p.nickname == args[0]){
						p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' clearchar`]));
						log(`Clear Character for ${args[0]}`);
						return;
					}
					else if (args[0] == "@a"){
						p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' clearchar`]));
					}
					else if (args[0] == "@s" && p.nickname == player.nickname){
						p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' clearchar`]));
						log(`Clear Character for ${args[0]}`);
						return;
					}
				}
				if (args[0] == "@a"){
					log(`Clear Character for everyone`);
					return;
				}
				
				log("Couldn't find player '" + args[0] + "'");
				
				break;
			case "autoplayer":
				autoplayer = !autoplayer;
				log(`autoplayer set to ${autoplayer}`);
				break;
			case "set":
				if (args.length < 3) {log("Expected 3 arguments: nickname,setting,value"); break;};
				
				for (let p of Object.values(players)){
					if (p.nickname == args[0]){
						p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' set ${args[1]} ${args[2]}`]));
						log(`set ${args[1]} of ${args[0]} to ${args[2]}`);
						return;
					}
					else if (args[0] == "@a")
					p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' set ${args[1]} ${args[2]}`]));
					else if (args[0] == "@s" && p.nickname == player.nickname){
						p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' set ${args[1]} ${args[2]}`]));
						log(`set ${args[1]} of ${player.nickname} to ${args[2]}`);
						return;
					}
				}
				if (args[0] == "@a"){
					log(`set ${args[1]} of Everyone to ${args[2]}`);
					return;
				}
				
				log("Couldn't find player '" + args[0] + "'");
				
				break;
			case "op":
				if (args.length < 1) {log("Expected 1 argument: nickname"); break;};
				
				for (let p of Object.values(players)){
					if (p.nickname == args[0]){
						p.admin = true;
						p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE, ["You are now an admin! Do !help for help."]));
						log(args[0] + " are now an admin!");
						return;
					}
				}
				log("Couldn't find player '" + args[0] + "'");
				break;
			case "deop":
				if (args.length < 1) {log("Expected 1 argument: nickname"); break;};
				
				for (let p of Object.values(players)){
					if (p.nickname == args[0]){
						p.admin = false;
						p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE, ["You are no longer an admin! :("]));
						log(args[0] + " are no longer an admin!");
						return;
					}
				}
				log("Couldn't find player '" + args[0] + "'");
				break;
			case "get":
				if (args.length < 2) {log("Expected 2 arguments: nickname,value"); break;};
				
				for (let p of Object.values(players)){
					if (p.nickname == args[0]){
						p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' get ${args[1]}`]));
						log(`get ${args[1]} of ${args[0]} to ${args[2]}`);
						return;
					}
					else if (args[0] == "@a")
					p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' get ${args[1]}`]));
					else if (args[0] == "@s" && p.nickname == player.nickname){
						p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' get ${args[1]}`]));
						log(`get ${args[1]} of ${player.nickname} to ${args[2]}`);
						return;
					}
				}
				if (args[0] == "@a"){
					log(`get ${args[1]} of Everyone to ${args[2]}`);
					return;
				}
				
				log("Couldn't find player '" + args[0] + "'");
				
				break;
			case "setteam":
				if (args.length < 2) {log("Expected 2 arguments: nickname,team"); break;};
				var IsGood = false;
				var ChangeTo = 0;
				if(args[1] == "Blue" || args[1] == "blue" || args[1] == 0)
					ChangeTo = 0;
				else if(args[1] == "Red" || args[1] == "red" || args[1] == 1)
					ChangeTo = 1;
				else
				{
					log(`The Team doesn't exist`);
					break;
				}
				for (let p of Object.values(players)){
					if (p.nickname == args[0]){
						p.team = ChangeTo;
						log(`set ${args[0]} to team ` + (ChangeTo == 0 ? "Blue" : "Red"));
						IsGood = true;
					}
					else if (args[0] == "@a"){
						p.team = ChangeTo;
						IsGood = true;
					}
					else if (args[0] == "@s" && p.nickname == player.nickname){
						p.team = ChangeTo;
						log(`set ${args[1]} of ${player.nickname} to ${args[2]}`);
						IsGood = true;
					}
				}
				if(IsGood){
					for (let p of Object.values(players)){
						switch(args[0]){
						case "@a": p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`Everyone have been move to `+ (ChangeTo == 0 ? "Blue" : "Red")]))
						case "@s": p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`${players.nickname} have been move to `+ (ChangeTo == 0 ? "Blue" : "Red")]))
						default: p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`${args[0]} have been move to `+ (ChangeTo == 0 ? "Blue" : "Red")]))
						}
					}
					return;
				}
				
				log("Couldn't find player '" + args[0] + "'");
				
				break;
			case "sendraw":
				if (args.length < 2) {log("Expected 2 arguments: nickname,command"); break;};
				
				for (let p of Object.values(players)){
					if (p.nickname == args[0]){
						cmd = args.slice(1).join(" ");
						p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' ${cmd}`]));
						log(`Sent "${cmd}" to ${args[0]}`);
						return;
					}
				}
				
				log("Couldn't find player '" + args[0] + "'");
				
				break;
			case "sendhscript":
				if (args.length < 3) {log("Expected 3 arguments: nickname,setting,value"); break;};
				
				for (let p of Object.values(players)){
					if (p.nickname == args[0]){
						p.socket.write(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE,[`'32d5d167' sendhscript ${args[1]} ${args[2]}`]));
						log(`Send ${args[1]} to ${args[0]} contain ${args[2]}`);
						return;
					}
				}
				
				log("Couldn't find player '" + args[0] + "'");
				
				break;
			case "ban":
				if (args.length < 1) {log("Expected 1 argument: nickname"); break;};
				for (let p of Object.values(players)){
					if (p.nickname == args[0]){
						log("Banned '" + p.nickname + "' from the game");
						
						// Add them to the ban list
						let ip = p.socket.remoteAddress;
						banlist.push(ip);
						fs.writeFile('banlist.json', JSON.stringify(banlist), (err) => {});
						
						p.destroy();
						return;
					}
				}
				
				log("Couldn't find player '" + args[0] + "'");
				
				break;
			case "mute":
				if (args.length < 1) {log("Expected 1 argument: nickname"); break;};
				for (let p of Object.values(players)){
					if (p.nickname == args[0]){
						log("Muted '" + p.nickname + "'");
						
						// Add them to the mute list
						let ip = p.socket.remoteAddress;
						mutelist.push(ip);
						fs.writeFile('mutelist.json', JSON.stringify(mutelist), (err) => {});
						
						p.muted = true;
						
						return;
					}
				}
				
				log("Couldn't find player '" + args[0] + "'");
				
				break;
			case "unmute":
				if (args.length < 1) {log("Expected 1 argument: nickname"); break;};
				for (let p of Object.values(players)){
					if (p.nickname == args[0]){
						
						// Remove them from the mute list
						let ip = p.socket.remoteAddress;
						let index = mutelist.indexOf(ip);
						if (index > -1){
							mutelist.splice(index, 1);
							fs.writeFile('mutelist.json', JSON.stringify(mutelist), (err) => {});
							p.muted = false;
							
							log("Unmuted '" + p.nickname + "'");
							return;
						}
						
						log("'" + p.nickname + "' isn't muted");
						return;
					}
				}
				
				log("Couldn't find player '" + args[0] + "'");
				
				break;
			
			case "say":
				if (args.length < 1) {log("Expected 1 argument: message"); break;};
				var message = input.substr(command.length + 1);
				broadcast(Sender.CreatePacket(packets.SERVER_CHAT_MESSAGE, [message]));
				log("Server : " + message);
				break;
			
			case "reload":
				fs.readFile('settings.json', (err, data) => {
					settings = JSON.parse(data);
					log("Reloaded settings");
				});
				fs.readFile('banlist.json', (err, data) => {
					banlist = JSON.parse(data);
					log("Reloaded banlist");
				});
				fs.readFile('mutelist.json', (err, data) => {
					mutelist = JSON.parse(data);
					log("Reloaded mutelist");
					
					for (p of Object.values(players)){
						p.muted = mutelist.includes(p.socket.remoteAddress);
					}
				});
				songLists = "";
				const files = fs.readdirSync('data/');
				files.forEach(function(file) {
					if (fs.lstatSync(path.join('data/', file)).isDirectory()) {
						const folderName = path.basename(file);
						const subFiles = fs.readdirSync(path.join('data/', file));
						subFiles.forEach(function(subFile) {
							if (path.extname(subFile) === '.json' && !blockedFiles.includes(subFile)) {
							const chartName = path.basename(subFile, '.json');
							songLists += `${chartName},${folderName} `;
						}
					});
					}
				});
				listVersion++;
				log("SongLists have been recached");
				break;
			
			case "cls":
				custom_console.body.setContent("");
				break;
			
			case "exit":
				for (let p of Object.values(players)){
					p.destroy();
				}
				process.exit(1);
				break;
		}
	}else{
		log("Couldn't recognize command '" + command + "'. Try using 'help'");
	}
}