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

// 自动重置的定时器引用
let autoResetTimer = null;

// 获取公开的桌面数据
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

// 核心：彻底重置游戏数据
function resetGameData() {
    console.log("所有玩家已退出，重置游戏数据...");
    players = {};
    tableCards = [];
    chatHistory = []; // 清空聊天记录
    gameConfig = {
        theme: "等待设置题目...",
        status: "waiting",
    };
}

io.on('connection', (socket) => {
    // 有人连接时，如果有待执行的重置任务（说明刚才有人刷新了），取消重置
    if (autoResetTimer) {
        console.log("检测到玩家重连，取消自动重置");
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
        
        // --- 聊天记录过滤 logic ---
        // 1. 获取当前时间
        const now = Date.now();
        // 2. 过滤掉超过 5 小时的消息 (5 * 60 * 60 * 1000)
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

    socket.on('startGame', (isRestart) => {
        tableCards = []; 
        gameConfig.status = 'playing'; 
        
        let numbers = Array.from({length: 100}, (_, i) => i + 1);
        numbers.sort(() => Math.random() - 0.5);

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

        io.to('gameRoom').emit('gameStarted', { activePlayerCount: getActivePlayerCount() });
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
                timestamp: Date.now() // 记录时间戳用于过滤
            };
            chatHistory.push(chatMsg);
            
            // 简单的内存限制，防止无限增长
            if (chatHistory.length > 100) chatHistory.shift();
            
            io.to('gameRoom').emit('chatMessage', chatMsg);
        }
    });

    socket.on('disconnect', () => {
        // 从 players 移除断开的 socket 对应的用户
        let disconnectedUid = null;
        for (let uid in players) {
            if (players[uid].socketId === socket.id) {
                disconnectedUid = uid;
                // 注意：这里我们选择暂时不删除 players[uid] 的数据结构，
                // 而是从 UI 列表里让他“消失”，或者标记为离线。
                // 但根据你的需求“所有人退出后清空”，我们需要即时移除连接状态。
                
                // 为了配合前端的“掉线重连”，通常我们会保留 player 数据一小会儿。
                // 但这里我们简单处理：直接从列表逻辑中剔除连接，
                // 如果用户马上重连，login 会重新接管。
                
                // 这里彻底删除玩家，配合下面的“全部无人”检测
                delete players[uid]; 
                break;
            }
        }

        io.to('gameRoom').emit('updatePlayerList', Object.values(players));

        // --- 核心：检测是否还有人 ---
        // 获取当前 Socket.IO 房间内的连接数
        const room = io.sockets.adapter.rooms.get('gameRoom');
        const numClients = room ? room.size : 0;

        console.log(`有人断开。当前剩余连接数: ${numClients}`);

        if (numClients === 0) {
            console.log("房间无人，10秒后将清空数据...");
            // 设置 10 秒倒计时，防止只是刷新页面
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
