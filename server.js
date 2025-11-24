const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

let players = {};
let gameStarted = false;
let currentTheme = "等待设置题目..."; // 默认题目
let playedCards = [];

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // 玩家加入
    socket.on('joinGame', (name) => {
        players[socket.id] = {
            id: socket.id,
            name: name,
            card: null,
            isSpectator: gameStarted
        };
        io.emit('updatePlayerList', Object.values(players));
        
        // 发送当前状态给新玩家
        socket.emit('themeUpdated', currentTheme); 
        if (gameStarted) {
            socket.emit('gameState', { playedCards: playedCards });
        }
    });

    // --- 新增：处理手动修改题目 ---
    socket.on('updateTheme', (newTheme) => {
        currentTheme = newTheme;
        // 广播给所有人：题目变了
        io.emit('themeUpdated', currentTheme);
    });

    // 开始游戏 (发牌)
    socket.on('startGame', () => {
        gameStarted = true;
        playedCards = [];
        
        // 生成1-100的随机数字
        let numbers = Array.from({length: 100}, (_, i) => i + 1);
        numbers.sort(() => Math.random() - 0.5);

        // 注意：这里不再随机选题目了，保持当前题目或等待玩家输入

        for (let id in players) {
            players[id].card = numbers.pop();
            players[id].isSpectator = false;
            io.to(id).emit('yourCard', players[id].card);
        }

        io.emit('gameStarted');
        // 同时广播一次当前的题目（防止状态不同步）
        io.emit('themeUpdated', currentTheme);
    });

    // 玩家出牌
    socket.on('playCard', () => {
        const player = players[socket.id];
        if (player && player.card) {
            playedCards.push({ name: player.name, number: player.card });
            player.card = null;
            io.emit('updateTable', playedCards);
            io.emit('cardPlayed', socket.id);
        }
    });

    // 重置游戏
    socket.on('resetGame', () => {
        gameStarted = false;
        playedCards = [];
        currentTheme = "等待设置题目..."; // 重置题目
        for (let id in players) {
            players[id].card = null;
        }
        io.emit('resetGame');
        io.emit('themeUpdated', currentTheme);
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('updatePlayerList', Object.values(players));
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});