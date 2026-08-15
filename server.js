const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;

// კარტის მნიშვნელობები და ქულები
const CARD_VALUES = {
    '7': 0, '8': 0, '9': 0, 'J': 2, 'Q': 3, 'K': 4, '10': 10, 'A': 11
};
const RANKS_ORDER = ['7', '8', '9', 'J', 'Q', 'K', '10', 'A'];
const SUITS = ['spades', 'clubs', 'hearts', 'diamonds'];
const TRUMP_ROTATION = ['spades', 'clubs', 'hearts', 'no_trump']; // ყვავი -> ჯვარი -> გული -> ბეზი

let room = {
    players: [],
    gameState: null
};

function createDeck() {
    let deck = [];
    for (let suit of SUITS) {
        for (let rank of RANKS_ORDER) {
            deck.push({ rank, suit, value: CARD_VALUES[rank] });
        }
    }
    // აჩეხვა
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function startNewGame(game = null) {
    let deck = createDeck();
    let p1Cards = deck.splice(0, 5);
    let p2Cards = deck.splice(0, 5);

    let party = game ? game.party : 1;
    let roundNum = game ? game.roundNum + 1 : 1;
    
    // კოზირის განსაზღვრა როტაციით
    let trumpIndex = (roundNum - 1) % 4;
    let currentTrump = TRUMP_ROTATION[trumpIndex];

    let p1Score = game ? game.p1GameScore : 0;
    let p2Score = game ? game.p2GameScore : 0;

    return {
        deck,
        playersCards: {
            [room.players[0].id]: p1Cards,
            [room.players[1].id]: p2Cards
        },
        takenCards: {
            [room.players[0].id]: [],
            [room.players[1].id]: []
        },
        currentTurn: game ? game.nextTurnLeader : room.players[0].id,
        table: [], // { playerId, cards }
        trump: currentTrump,
        party: party,
        roundNum: roundNum,
        p1GameScore: p1Score,
        p2GameScore: p2Score,
        nextTurnLeader: game ? game.nextTurnLeader : room.players[0].id
    };
}

// ამოწმებს, ჭრის თუ არა მეორე სვლა პირველს
function beatsHand(leadCards, attackCards, trump) {
    if (leadCards.length !== attackCards.length) return false;

    let leadSuit = leadCards[0].suit;
    let allSameSuit = attackCards.every(c => c.suit === attackCards[0].suit);
    if (!allSameSuit) return false;

    let attackSuit = attackCards[0].suit;

    // თუ ჩამოსვლა კოზირია (თუ ბეზი არ არის)
    let isAttackTrump = (trump !== 'no_trump' && attackSuit === trump);
    let isLeadTrump = (trump !== 'no_trump' && leadSuit === trump);

    if (isAttackTrump && !isLeadTrump) return true;

    if (attackSuit === leadSuit) {
        // შევადაროთ უმაღლესი კარტები
        let maxLeadRank = Math.max(...leadCards.map(c => RANKS_ORDER.indexOf(c.rank)));
        let maxAttackRank = Math.max(...attackCards.map(c => RANKS_ORDER.indexOf(c.rank)));
        return maxAttackRank > maxLeadRank;
    }

    return false;
}

io.on('connection', (socket) => {
    if (room.players.length < 2) {
        room.players.push({ id: socket.id, name: მოთამაშე ${room.players.length + 1} });
        socket.emit('playerAssigned', room.players.length);
    } else {
        socket.emit('roomFull');
        return;
    }

    if (room.players.length === 2 && !room.gameState) {
        room.gameState = startNewGame();
        io.emit('gameStateUpdate', getClientGameState());
    }

    socket.on('playCards', (cardIndices) => {
        let gs = room.gameState;
        if (!gs || gs.currentTurn !== socket.id) return;

        let playerCards = gs.playersCards[socket.id];
        let selectedCards = cardIndices.map(i => playerCards[i]).filter(Boolean);

        if (selectedCards.length === 0) return;

        // წესი 1: ერთზე მეტი კარტის ჩასვლისას, ყველა უნდა იყოს ერთი ცვეტი
        let firstSuit = selectedCards[0].suit;
        let isSameSuit = selectedCards.every(c => c.suit === firstSuit);
        if (!isSameSuit) {
            socket.emit('errorMessage', 'შეეგიძლიათ ჩამოხვიდეთ მხოლოდ ერთი ცვეტის კარტები!');
            return;
        }

        // პირველი სვლა მაგიდაზე
        if (gs.table.length === 0) {
            // ამოვიღოთ ჩამოშორებული კარტები ხელიდან
            gs.playersCards[socket.id] = playerCards.filter((_, i) => !cardIndices.includes(i));
            gs.table.push({ playerId: socket.id, cards: selectedCards });
            
            // გადავიდეს რიგი მეორეზე
            let opponentId = room.players.find(p => p.id !== socket.id).id;
            gs.currentTurn = opponentId;
            io.emit('gameStateUpdate', getClientGameState());
        } 
        // მეორე სვლა (პასუხი / გაჭრა)
        else if (gs.table.length === 1) {
            let leadPlay = gs.table[0];
            if (selectedCards.length !== leadPlay.cards.length) {
                socket.emit('errorMessage', უნდა ჩამოხვიდეთ ზუსტად ${leadPlay.cards.length} კარტი!);
                return;
            }

            gs.playersCards[socket.id] = playerCards.filter((_, i) => !cardIndices.includes(i));
            gs.table.push({ playerId: socket.id, cards: selectedCards });

            let isBeaten = beatsHand(leadPlay.cards, selectedCards, gs.trump);
            let winnerId = isBeaten ? socket.id : leadPlay.playerId;

            // რაუნდის გამარჯვებული იღებს კარტებს
            let allTableCards = [...leadPlay.cards, ...selectedCards];
            gs.takenCards[winnerId].push(...allTableCards);

            // გამარჯვებული ჩამოვა შემდეგში
            gs.nextTurnLeader = winnerId;
            gs.currentTurn = winnerId;

            io.emit('gameStateUpdate', getClientGameState());

            // 1.5 წამში წაიღოს კარტები და შეავსოს 5-მდე
            setTimeout(() => {
                gs.table = [];
                
                // შევსება 5-მდე (ჯერ ივსებს ის, ვინც წაიღო)
                let otherId = room.players.find(p => p.id !== winnerId).id;
                
                while (gs.playersCards[winnerId].length < 5 && gs.deck.length > 0) {
                    gs.playersCards[winnerId].push(gs.deck.pop());
                }
                while (gs.playersCards[otherId].length < 5 && gs.deck.length > 0) {
                    gs.playersCards[otherId].push(gs.deck.pop());
                }

                // თუ კარტები დამთავრდა და ხელშიც აღარავის აქვს -> დარიგების დასასრული
                let p1Hand = gs.playersCards[room.players[0].id].length;
                let p2Hand = gs.playersCards[room.players[1].id].length;

                if (p1Hand === 0 && p2Hand === 0) {
                    finishRound();
                } else {
                    io.emit('gameStateUpdate', getClientGameState());
                }
            }, 1500);
        }
    });

    socket.on('disconnect', () => {
        room.players = room.players.filter(p => p.id !== socket.id);
        room.gameState = null;
        io.emit('playerLeft');
    });
});

function finishRound() {
    let gs = room.gameState;
    let p1Id = room.players[0].id;
    let p2Id = room.players[1].id;

    let p1Pts = gs.takenCards[p1Id].reduce((acc, c) => acc + c.value, 0);
    let p2Pts = gs.takenCards[p2Id].reduce((acc, c) => acc + c.value, 0);

    if (p1Pts > p2Pts) {
        gs.p1GameScore += 1;
    } else if (p2Pts > p1Pts) {
        gs.p2GameScore += 1;
    }

    // ახალი დარიგების დაწყება
    room.gameState = startNewGame(gs);
    io.emit('gameStateUpdate', getClientGameState());
}

function getClientGameState() {
    return room.gameState;
}

// HTML / Client UI
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="ka">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ბურა / Bura Game</title>
    <script src="/socket.io/socket.io.js"></script>
    <style>
        body { font-family: Arial, sans-serif; background: #1a472a; color: white; text-align: center; margin: 0; padding: 10px; }
        #info-board { background: rgba(0,0,0,0.5); padding: 10px; border-radius: 8px; margin-bottom: 15px; font-size: 18px; }
        .suit-icon { font-size: 22px; font-weight: bold; }
        .red { color: #ff4d4d; }
        .black { color: #ffffff; }
        #table { min-height: 160px; background: rgba(0,0,0,0.2); border: 2px dashed #fff3; border-radius: 10px; display: flex; justify-content: center; align-items: center; gap: 20px; margin: 15px 0; padding: 10px; }
        .card-group { display: flex; gap: 5px; background: rgba(255,255,255,0.1); padding: 5px; border-radius: 6px; }
        .card { width: 70px; height: 105px; background: white; color: black; border-radius: 6px; border: 2px solid #333; display: flex; flex-direction: column; justify-content: space-between; padding: 5px; font-weight: bold; font-size: 18px; cursor: pointer; user-select: none; box-shadow: 2px 2px 8px rgba(0,0,0,0.4); }
        .card.selected { border: 3px solid #ffcc00; transform: translateY(-10px); }
        .card .suit { font-size: 28px; text-align: center; }
        #my-cards { display: flex; justify-content: center; gap: 10px; margin-top: 20px; min-height: 120px; }
        button { padding: 12px 24px; font-size: 18px; background: #ffcc00; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; margin-top: 10px; }
        button:disabled { background: #888; cursor: not-allowed; }
        #status { font-size: 20px; margin: 10px 0; color: #ffeb3b; }
    </style>
</head>
<body>
    <h1>ბურა ონლაინ</h1>
    <div id="info-board">
        <div>პარტია: <b id="party-num">1</b> | დარიგება: <b id="round-num">1</b></div>
        <div>კოზირი: <span id="trump-display">-</span></div>
        <div>ანგარიში (პარტიები): მოთამაშე 1 [<b id="score1">0</b>] - [<b id="score2">0</b>] მოთამაშე 2</div>
    </div>

    <div id="status">მუშაობს...</div>

    <h3>მაგიდა</h3>
    <div id="table"></div>

    <h3>ჩემი კარტები</h3>
    <div id="my-cards"></div>
    <br>
    <button id="play-btn" onclick="playSelectedCards()">ჩამოსვლა</button>

    <script>
        const socket = io();
        let myCards = [];
        let selectedIndices = [];
        let myId = null;

        const SUIT_SYMBOLS = {
            'spades': '♠', 'clubs': '♣', 'hearts': '♥', 'diamonds': '♦', 'no_trump': 'ბეზი (უკოზიროდ)'
        };

        socket.on('connect', () => { myId = socket.id; });

        socket.on('errorMessage', (msg) => { alert(msg); });

        socket.on('gameStateUpdate', (gs) => {
            document.getElementById('party-num').innerText = gs.party;
            document.getElementById('round-num').innerText = gs.roundNum;
            document.getElementById('score1').innerText = gs.p1GameScore;
            document.getElementById('score2').innerText = gs.p2GameScore;

            // კოზირის ჩვენება
            let trumpText = SUIT_SYMBOLS[gs.trump] || gs.trump;
            let trumpSpan = document.getElementById('trump-display');
            if (gs.trump === 'hearts' || gs.trump === 'diamonds') {
                trumpSpan.innerHTML = \`<b class="red">\${trumpText}</b>\`;
            } else if (gs.trump === 'spades' || gs.trump === 'clubs') {
                trumpSpan.innerHTML = \`<b class="black">\${trumpText}</b>\`;
            } else {
                trumpSpan.innerHTML = \`<b>\${trumpText}</b>\`;
            }

            // სტატუსი
            let isMyTurn = (gs.currentTurn === myId);
            document.getElementById('status').innerText = isMyTurn ? "თქვენი სვლაა!" : "მოწინააღმდეგის სვლაა...";
            document.getElementById('play-btn').disabled = !isMyTurn;

            // მაგიდის განახლება
            let tableDiv = document.getElementById('table');
            tableDiv.innerHTML = '';
            gs.table.forEach(group => {
                let gDiv = document.createElement('div');
                gDiv.className = 'card-group';
                group.cards.forEach(c => {
                    gDiv.appendChild(renderCardUI(c));
                });
                tableDiv.appendChild(gDiv);
            });

            // ჩემი კარტები
            myCards = gs.playersCards[myId] || [];
            selectedIndices = [];
            renderMyCards();
        });

        function renderCardUI(card, isSelectable = false, index = -1) {
            let div = document.createElement('div');
            let isRed = (card.suit === 'hearts' || card.suit === 'diamonds');
            div.className = card ${isRed ? 'red' : 'black'};
            if (selectedIndices.includes(index)) div.classList.add('selected');

            let symbol = SUIT_SYMBOLS[card.suit] || '';
            div.innerHTML = `
                <div>${card.rank}</div>
                <div class="suit">${symbol}</div>
                <div style="text-align:right">${card.rank}</div>
            `;

            if (isSelectable) {
                div.onclick = () => {
                    if (selectedIndices.includes(index)) {
                        selectedIndices = selectedIndices.filter(i => i !== index);
                    } else {
                        selectedIndices.push(index);
                    }
                    renderMyCards();
                };
            }
            return div;
        }

        function renderMyCards() {
            let cardsDiv = document.getElementById('my-cards');
            cardsDiv.innerHTML = '';
            myCards.forEach((c, i) => {
                cardsDiv.appendChild(renderCardUI(c, true, i));
            });
        }

        function playSelectedCards() {
            if (selectedIndices.length === 0) return;
            socket.emit('playCards', selectedIndices);
        }
    </script>
</body>
</html>
    `);
});

server.listen(PORT, () => {
    console.log(Server executing on port ${PORT});
});
