const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

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
    return Object.values(players).filter(p => !p.isSpectator).length;
}

function resetGameData() {
    console.log("所有玩家已退出，重置游戏数据...");
    players = {};
    tableCards = [];
    chatHistory = [];
    gameConfig = {
        theme: "等待设置题目...",
        status: "waiting",
    };
}

io.on('connection', (socket) => {
    if (autoResetTimer) {
        clearTimeout(autoResetTimer);
        autoResetTimer = null;
    }

    socket.on('login', ({ uid, name }) => {
        let isNewUser = !players[uid];
        let isSpectator = false;

        if (isNewUser && gameConfig.status === 'playing') {
            isSpectator = true;
        } 
        
        if (players[uid]) {
            players[uid].socketId = socket.id;
            players[uid].name = name || players[uid].name;
        } else {
            players[uid] = {
                uid: uid,
                name: name || "无名氏",
                card: null,
                desc: "",
                isPlayed: false,
                isSpectator: isSpectator,
                socketId: socket.id
            };
        }
        
        socket.join('gameRoom');
        
        const now = Date.now();
        // 过滤5小时内的消息
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

    socket.on('updateTheme', (theme) => {
        gameConfig.theme = theme;
        io.to('gameRoom').emit('updateTheme', theme);
    });

    // --- 核心修复位置 ---
    socket.on('startGame', (isRestart) => {
        tableCards = []; 
        gameConfig.status = 'playing'; 
        
        let numbers = Array.from({length: 100}, (_, i) => i + 1);
        numbers.sort(() => Math.random() - 0.5);

        // 1. 先广播游戏开始 (让前端重置界面，清空旧数据)
        io.to('gameRoom').emit('gameStarted', { activePlayerCount: getActivePlayerCount() });

        // 2. 然后再发新的手牌 (前端收到后会写入 myCurrentNumber)
        for (let uid in players) {
            players[uid].isSpectator = false;
            players[uid].card = numbers.pop();
            players[uid].desc = "";     
            players[uid].isPlayed = false;
            
            const socketId = players[uid].socketId;
            if (socketId) {
                io.to(socketId).emit('yourCard', { number: players[uid].card, desc: "" });
            }
        }

        io.to('gameRoom').emit('updateTable', getPublicTableData()); 
        io.to('gameRoom').emit('updatePlayerList', Object.values(players));
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
        let disconnectedUid = null;
        for (let uid in players) {
            if (players[uid].socketId === socket.id) {
                disconnectedUid = uid;
                delete players[uid]; 
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
