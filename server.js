/**
 * Ito Online Server - Ver.2.1 (Double Card Mode Support)
 * 更新点：
 * 1. 重构数据结构：单张牌 -> 手牌数组 (hand)
 * 2. 支持双牌模式发牌逻辑
 * 3. 基于 cardId 的精确操作
 */

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

// 生成简短的唯一ID用于卡牌标识
function generateCardId() {
    return Math.random().toString(36).substr(2, 9);
}

function getPublicTableData() {
    if (gameConfig.status === 'revealed') {
        return tableCards; 
    } else {
        return tableCards.map(c => ({
            uid: c.uid,
            cardId: c.cardId, // 新增：用于前端识别
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

// 辅助函数：发牌逻辑 (支持多张)
function dealCardsToPlayers() {
    let numbers = Array.from({length: 100}, (_, i) => i + 1);
    numbers.sort(() => Math.random() - 0.5);

    // 根据模式决定发几张
    const cardsPerPlayer = gameConfig.mode === 'double' ? 2 : 1;

    for (let uid in players) {
        const p = players[uid];
        
        // 仅给在线、非旁观者、且手中没有牌的玩家发牌
        // 注意：如果有残留手牌（比如掉线重连），则不补发，除非强制重置
        if (!p.isSpectator && p.online && p.hand.length === 0) {
            for (let i = 0; i < cardsPerPlayer; i++) {
                if (numbers.length === 0) break;
                p.hand.push({
                    cardId: generateCardId(),
                    number: numbers.pop(),
                    desc: ""
                });
            }
            
            const socketId = p.socketId;
            if (socketId) {
                io.to(socketId).emit('yourHand', p.hand); // 发送整个手牌数组
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
                hand: [], // 改为数组
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

    socket.on('updateTheme', (theme) => {
        if (gameConfig.status !== 'playing' && gameConfig.status !== 'waiting') return;
        if (tableCards.length > 0) return;

        gameConfig.theme = theme;
        io.to('gameRoom').emit('updateTheme', theme);

        if (gameConfig.status === 'playing') {
            dealCardsToPlayers();
        }
    });

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

    socket.on('startGame', (mode) => {
        tableCards = []; 
        gameConfig.status = 'playing'; 
        gameConfig.mode = mode || 'normal';
        gameConfig.theme = "请设置主题以开始发牌..."; 

        io.to('gameRoom').emit('updateTheme', gameConfig.theme);
        
        io.to('gameRoom').emit('gameStarted', { 
            activePlayerCount: getActivePlayerCount(),
            mode: gameConfig.mode
        });

        for (let uid in players) {
            players[uid].isSpectator = false; 
            players[uid].hand = []; // 清空手牌
            
            const socketId = players[uid].socketId;
            if (socketId && players[uid].online) {
                io.to(socketId).emit('yourHand', []); // 清空前端手牌
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

    // --- 玩家操作：更新描述 (需要 cardId) ---
    socket.on('updateDesc', ({ uid, cardId, desc }) => {
        const p = players[uid];
        if (p) {
            const card = p.hand.find(c => c.cardId === cardId);
            if (card) card.desc = desc;
        }
    });

    // --- 玩家操作：出牌 (需要 cardId) ---
    socket.on('playCard', ({ uid, cardId }) => {
        const p = players[uid];
        if (p) {
            // 在手牌中查找
            const cardIndex = p.hand.findIndex(c => c.cardId === cardId);
            if (cardIndex !== -1) {
                const card = p.hand[cardIndex];
                
                // 从手牌移除
                p.hand.splice(cardIndex, 1);

                // 加入桌面
                tableCards.push({
                    uid: p.uid,
                    cardId: card.cardId, // 传递ID
                    name: p.name,
                    desc: card.desc,
                    number: card.number
                });
                
                io.to('gameRoom').emit('updateTable', getPublicTableData()); 
                // 告诉该玩家更新手牌
                io.to(p.socketId).emit('yourHand', p.hand); 
                io.to('gameRoom').emit('updatePlayerList', Object.values(players));
            }
        }
    });

    socket.on('reorderCards', (newOrderIndices) => {
        if (!Array.isArray(newOrderIndices)) return;
        
        // 这里前端传来的 index 其实是 cardId (我们在 renderTable 时会把 cardId 设为 data-id)
        // 或者保持原样用 data-uid，但在双牌模式下，一个uid有两张牌，排序会有问题
        // *修正*：前端 Sortable 必须使用 cardId 作为唯一标识
        
        const newTable = [];
        newOrderIndices.forEach(cardId => {
            const card = tableCards.find(c => c.cardId === cardId);
            if (card) newTable.push(card);
        });

        if (newTable.length === tableCards.length) {
            tableCards = newTable;
            io.to('gameRoom').emit('updateTable', getPublicTableData()); 
        }
    });
    
    // --- 玩家操作：收回牌 (需要 cardId) ---
    socket.on('takeBackCard', ({uid, cardId}) => {
        const p = players[uid];
        if(p && gameConfig.status !== 'revealed') {
            // 在桌面查找
            const cardIndex = tableCards.findIndex(c => c.cardId === cardId);
            
            if (cardIndex !== -1 && tableCards[cardIndex].uid === uid) {
                const card = tableCards[cardIndex];
                
                // 从桌面移除
                tableCards.splice(cardIndex, 1);
                
                // 放回手牌
                p.hand.push({
                    cardId: card.cardId,
                    number: card.number,
                    desc: card.desc
                });

                io.to('gameRoom').emit('updateTable', getPublicTableData());
                io.to(p.socketId).emit('yourHand', p.hand); 
                io.to('gameRoom').emit('updatePlayerList', Object.values(players));
            }
        }
    });

    socket.on('revealCards', () => {
        const activeCount = getActivePlayerCount();
        if (activeCount === 0) return;

        // 校验：是否所有活跃玩家的手牌都出完了？
        // 在双牌模式下，简单的 count 比较不够，需要检查每个活跃玩家的 hand 数组是否为空
        let allHandsEmpty = true;
        for(let uid in players) {
            const p = players[uid];
            if (!p.isSpectator && p.online && p.hand.length > 0) {
                allHandsEmpty = false;
                break;
            }
        }

        // 如果桌上没牌，或者还有人手里有牌，则不能结算
        if (tableCards.length === 0 || !allHandsEmpty) return;

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
