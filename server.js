const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const PRESET_THEMES = require('./themes.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    pingTimeout: 60000,
    pingInterval: 25000
});

app.use(express.static(__dirname));

// --- 数据存储 ---
let players = {}; 
let tableCards = []; 
let chatHistory = []; 
let gameConfig = {
    theme: "等待设置题目...",
    status: "waiting", 
    mode: "normal" 
};

let autoResetTimer = null;

function getPublicTableData() {
    if (gameConfig.status === 'revealed') {
        return tableCards; 
    } else {
        return tableCards.map(c => ({
            uid: c.uid,
            name: c.name,
            desc: c.desc,
            number: null 
        }));
    }
}

function getActivePlayerCount() {
    return Object.values(players).filter(p => !p.isSpectator && p.online).length;
}

function resetGameData() {
    console.log("执行全局重置...");
    players = {};
    tableCards = [];
    chatHistory = [];
    gameConfig = {
        theme: "等待设置题目...",
        status: "waiting",
        mode: "normal"
    };
}

// 辅助函数：发牌逻辑
function dealCardsToPlayers() {
    let numbers = Array.from({length: 100}, (_, i) => i + 1);
    numbers.sort(() => Math.random() - 0.5);

    for (let uid in players) {
        const p = players[uid];
        // 只有当是正规玩家、在线、且当前没有牌时，才发牌
        if (!p.isSpectator && p.online && p.card === null) {
            p.card = numbers.pop();
            p.desc = ""; // 重置描述
            const socketId = p.socketId;
            if (socketId) {
                io.to(socketId).emit('yourCard', { number: p.card, desc: "" });
            }
        }
    }
}

io.on('connection', (socket) => {
    if (autoResetTimer) {
        clearTimeout(autoResetTimer);
        autoResetTimer = null;
    }

    socket.on('login', ({ uid, name }) => {
        let isNewUser = !players[uid];
        
        if (players[uid]) {
            players[uid].socketId = socket.id;
            players[uid].name = name || players[uid].name;
            players[uid].online = true; 
        } else {
            let isSpectator = false;
            if (gameConfig.status === 'playing') {
                isSpectator = true;
            }

            players[uid] = {
                uid: uid,
                name: name || "无名氏",
                card: null,
                desc: "",
                isPlayed: false,
                isSpectator: isSpectator,
                online: true,
                socketId: socket.id
            };
        }
        
        socket.join('gameRoom');
        
        const now = Date.now();
        chatHistory = chatHistory.filter(msg => (now - msg.timestamp) < 5 * 60 * 60 * 1000);

        socket.emit('loginSuccess', {
            me: players[uid],
            gameConfig: gameConfig,
            tableCards: getPublicTableData(),
            chatHistory: chatHistory, 
            activePlayerCount: getActivePlayerCount()
        });
        
        io.to('gameRoom').emit('updatePlayerList', Object.values(players));
    });

    // --- 修改：设置题目时才发牌 ---
    socket.on('updateTheme', (theme) => {
        // 只有在游戏进行中才允许设置
        if (gameConfig.status !== 'playing' && gameConfig.status !== 'waiting') return;

        // 如果已经有牌打出去了，禁止修改题目 (虽然前端做了限制，后端也最好校验)
        if (tableCards.length > 0) return;

        gameConfig.theme = theme;
        io.to('gameRoom').emit('updateTheme', theme);

        // 如果游戏正在进行中，尝试发牌
        if (gameConfig.status === 'playing') {
            dealCardsToPlayers();
        }
    });

    // --- 修改：随机题目逻辑同上 ---
    socket.on('requestRandomTheme', () => {
        if (gameConfig.status !== 'playing' && gameConfig.status !== 'waiting') return;
        if (tableCards.length > 0) return;

        const randomIndex = Math.floor(Math.random() * PRESET_THEMES.length);
        const rawTheme = PRESET_THEMES[randomIndex];
        const formattedTheme = `随机主题#${randomIndex + 1}：${rawTheme}`;
        
        gameConfig.theme = formattedTheme;
        io.to('gameRoom').emit('updateTheme', formattedTheme);

        if (gameConfig.status === 'playing') {
            dealCardsToPlayers();
        }
    });

    // --- 修改：开始游戏不再发牌，只重置状态 ---
    socket.on('startGame', (mode) => {
        tableCards = []; 
        gameConfig.status = 'playing'; 
        gameConfig.mode = mode || 'normal';
        gameConfig.theme = "请设置主题以开始发牌..."; // 提示语

        io.to('gameRoom').emit('updateTheme', gameConfig.theme);
        
        io.to('gameRoom').emit('gameStarted', { 
            activePlayerCount: getActivePlayerCount(),
            mode: gameConfig.mode
        });

        // 重置所有人的手牌为 null
        for (let uid in players) {
            players[uid].isSpectator = false; 
            players[uid].card = null; // 清空手牌
            players[uid].desc = "";     
            players[uid].isPlayed = false;
            
            const socketId = players[uid].socketId;
            if (socketId && players[uid].online) {
                // 发送空牌给前端，清空界面
                io.to(socketId).emit('yourCard', { number: null, desc: "" });
            }
        }

        io.to('gameRoom').emit('updateTable', getPublicTableData()); 
        io.to('gameRoom').emit('updatePlayerList', Object.values(players));
    });

    socket.on('emergencyReset', (password) => {
        let requestPlayer = null;
        for(let uid in players) {
            if (players[uid].socketId === socket.id) {
                requestPlayer = players[uid];
                break;
            }
        }

        if (requestPlayer) {
            if (requestPlayer.isSpectator) {
                if (password !== 'admin') {
                    socket.emit('errorMessage', '管理员密码错误，无法重置。');
                    return;
                }
            }
            resetGameData();
            io.to('gameRoom').emit('forceReset');
        }
    });

    socket.on('updateDesc', ({ uid, desc }) => {
        if (players[uid]) players[uid].desc = desc;
    });

    socket.on('playCard', ({ uid }) => {
        const p = players[uid];
        if (p && p.card && !p.isPlayed) {
            p.isPlayed = true;
            tableCards.push({
                uid: p.uid,
                name: p.name,
                desc: p.desc,
                number: p.card
            });
            
            io.to('gameRoom').emit('updateTable', getPublicTableData()); 
            io.to('gameRoom').emit('playerPlayed', uid); 
            io.to('gameRoom').emit('updatePlayerList', Object.values(players));
        }
    });

    socket.on('reorderCards', (newOrderIndices) => {
        if (!Array.isArray(newOrderIndices)) return;
        
        const newTable = [];
        newOrderIndices.forEach(uid => {
            const card = tableCards.find(c => c.uid === uid);
            if (card) newTable.push(card);
        });

        if (newTable.length === tableCards.length) {
            tableCards = newTable;
            io.to('gameRoom').emit('updateTable', getPublicTableData()); 
        }
    });
    
    socket.on('takeBackCard', ({uid}) => {
        const p = players[uid];
        if(p && p.isPlayed && gameConfig.status !== 'revealed') {
            p.isPlayed = false;
            tableCards = tableCards.filter(c => c.uid !== uid);
            io.to('gameRoom').emit('updateTable', getPublicTableData());
            io.to('gameRoom').emit('playerTakenBack', uid);
            io.to('gameRoom').emit('updatePlayerList', Object.values(players));
        }
    });

    socket.on('revealCards', () => {
        const activeCount = getActivePlayerCount();
        if (tableCards.length < activeCount || activeCount === 0) return;

        gameConfig.status = 'revealed';
        
        let isSuccess = true;
        let failedIndices = [];
        
        for (let i = 0; i < tableCards.length - 1; i++) {
            if (tableCards[i].number > tableCards[i+1].number) {
                isSuccess = false;
                failedIndices.push(i); 
            }
        }
        
        io.to('gameRoom').emit('gameResult', { 
            tableCards: tableCards, 
            isSuccess: isSuccess,
            failedIndices: failedIndices
        });
        
        // 游戏结束，全员转正
        for (let uid in players) {
            players[uid].isSpectator = false; 
        }
        io.to('gameRoom').emit('updatePlayerList', Object.values(players));
        io.to('gameRoom').emit('gameEnded');
    });

    socket.on('sendChat', ({ uid, msg }) => {
        const p = players[uid];
        if (p && msg.trim().length > 0) {
            const chatMsg = { 
                name: p.name, 
                msg: msg,
                timestamp: Date.now()
            };
            chatHistory.push(chatMsg);
            if (chatHistory.length > 100) chatHistory.shift();
            io.to('gameRoom').emit('chatMessage', chatMsg);
        }
    });

    socket.on('disconnect', () => {
        for (let uid in players) {
            if (players[uid].socketId === socket.id) {
                players[uid].online = false; 
                break;
            }
        }
        
        io.to('gameRoom').emit('updatePlayerList', Object.values(players));

        const room = io.sockets.adapter.rooms.get('gameRoom');
        const numClients = room ? room.size : 0;

        if (numClients === 0) {
            autoResetTimer = setTimeout(() => {
                resetGameData();
            }, 10000); 
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
