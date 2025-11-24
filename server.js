const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

// 数据存储
let players = {}; // 格式: { uid: { name, card, desc, isPlayed, socketId } }
let tableCards = []; // 格式: [{ uid, name, desc, number }] (有序数组)
let gameConfig = {
    theme: "等待设置题目...",
    isRevealed: false // 是否已开牌
};

io.on('connection', (socket) => {
    // 1. 玩家登录/重连
    socket.on('login', ({ uid, name }) => {
        // 如果是老玩家重连
        if (players[uid]) {
            players[uid].socketId = socket.id; // 更新最新的 socket 连接
            // 如果玩家改名了，也可以在这里更新
            if(name) players[uid].name = name; 
        } else {
            // 新玩家
            players[uid] = {
                uid: uid,
                name: name || "无名氏",
                card: null,
                desc: "",
                isPlayed: false,
                socketId: socket.id
            };
        }
        
        socket.join('gameRoom');
        socket.emit('loginSuccess', players[uid]);
        
        // 发送当前游戏状态
        socket.emit('gameState', {
            theme: gameConfig.theme,
            isRevealed: gameConfig.isRevealed,
            tableCards: tableCards
        });
        
        io.to('gameRoom').emit('updatePlayerList', Object.values(players));
    });

    // 2. 修改题目
    socket.on('updateTheme', (theme) => {
        gameConfig.theme = theme;
        io.to('gameRoom').emit('updateTheme', theme);
    });

    // 3. 开始新游戏
    socket.on('startGame', () => {
        tableCards = []; // 清空桌面
        gameConfig.isRevealed = false; // 盖上牌
        
        let numbers = Array.from({length: 100}, (_, i) => i + 1);
        numbers.sort(() => Math.random() - 0.5);

        for (let uid in players) {
            players[uid].card = numbers.pop();
            players[uid].desc = "";     // 清空描述
            players[uid].isPlayed = false;
            
            // 发私信告诉玩家自己的牌
            const socketId = players[uid].socketId;
            if (socketId) {
                io.to(socketId).emit('yourCard', { number: players[uid].card, desc: "" });
            }
        }

        io.to('gameRoom').emit('gameStarted');
        io.to('gameRoom').emit('updateTable', tableCards); // 广播清空后的桌面
        io.to('gameRoom').emit('updatePlayerList', Object.values(players));
    });

    // 4. 更新描述
    socket.on('updateDesc', ({ uid, desc }) => {
        if (players[uid]) {
            players[uid].desc = desc;
            // 只需要告诉自己更新成功（或者刷新UI）
        }
    });

    // 5. 出牌 (加入到桌面队列末尾)
    socket.on('playCard', ({ uid }) => {
        const p = players[uid];
        if (p && p.card && !p.isPlayed) {
            p.isPlayed = true;
            // 添加到桌面列表
            tableCards.push({
                uid: p.uid,
                name: p.name,
                desc: p.desc,
                number: p.card
            });
            
            io.to('gameRoom').emit('updateTable', tableCards);
            io.to('gameRoom').emit('playerPlayed', uid); // 通知前端该玩家状态变化
            io.to('gameRoom').emit('updatePlayerList', Object.values(players));
        }
    });

    // 6. 拖拽排序 (更新 tableCards 顺序)
    socket.on('reorderCards', (newOrderIndices) => {
        // 前端发来的是新的索引顺序，比如 [2, 0, 1]
        // 为了安全，我们通常建议前端发来完整的uid列表，这里简单处理：
        // 假设前端发来的是重排后的 uid 数组
        if (!Array.isArray(newOrderIndices)) return;
        
        // 根据前端发来的 uid 顺序重组 tableCards
        const newTable = [];
        newOrderIndices.forEach(uid => {
            const card = tableCards.find(c => c.uid === uid);
            if (card) newTable.push(card);
        });

        // 只有当数量一致时才应用（防止并发冲突）
        if (newTable.length === tableCards.length) {
            tableCards = newTable;
            // 广播新的顺序，但不包含 user id 之外的敏感信息（虽然这里已经包含数字了，但前端根据 isRevealed 决定显不显示）
            socket.to('gameRoom').emit('updateTable', tableCards); // 发给其他人
        }
    });
    
    // 7. 撤回/拿回手牌 (可选功能，防止误触)
    socket.on('takeBackCard', ({uid}) => {
        const p = players[uid];
        if(p && p.isPlayed && !gameConfig.isRevealed) {
            p.isPlayed = false;
            // 从桌面上移除
            tableCards = tableCards.filter(c => c.uid !== uid);
            io.to('gameRoom').emit('updateTable', tableCards);
            io.to('gameRoom').emit('playerTakenBack', uid);
            io.to('gameRoom').emit('updatePlayerList', Object.values(players));
        }
    });

    // 8. 开牌！
    socket.on('revealCards', () => {
        gameConfig.isRevealed = true;
        
        // 判定结果
        let isSuccess = true;
        let failedIndices = [];
        
        for (let i = 0; i < tableCards.length - 1; i++) {
            if (tableCards[i].number > tableCards[i+1].number) {
                isSuccess = false;
                // 标记错误的牌（比如当前张比下一张大，那这两张之间就有问题，通常高亮前者或后者，这里高亮前者）
                failedIndices.push(i); 
            }
        }
        
        io.to('gameRoom').emit('gameResult', { 
            tableCards: tableCards, // 发送带数字的列表
            isSuccess: isSuccess,
            failedIndices: failedIndices
        });
    });

    // 重置
    socket.on('resetGame', () => {
        gameConfig.theme = "等待设置题目...";
        gameConfig.isRevealed = false;
        tableCards = [];
        // 重置所有玩家状态但不踢出
        for(let uid in players) {
            players[uid].card = null;
            players[uid].desc = "";
            players[uid].isPlayed = false;
        }
        io.to('gameRoom').emit('resetGame');
        io.to('gameRoom').emit('updatePlayerList', Object.values(players));
    });

    socket.on('disconnect', () => {
        // 不删除玩家数据，为了支持重连
        // 可以设置一个超时清理逻辑，这里暂略
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
