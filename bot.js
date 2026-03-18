require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const axios = require('axios');
const qrcode = require('qrcode-terminal');

const GROQ_API_KEY = process.env.GROQ_API_KEY;

if (!GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY not found in .env file');
}

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true
    }
});

client.on('qr', qr => {
    qrcode.generate(qr, { small: true });
});

// Track when bot started to ignore old messages
let botStartTime = null;

client.on('ready', () => {
    botStartTime = Date.now();
    console.log('Bot is ready!');
});

// Numbers to ignore (don't send auto-reply)
const ignoredNumbers = [
    '8618842366997'
];

// Track reply count per user (resets after 1 hour)
const replyTracker = new Map();
const MAX_REPLIES = 3;
const RESET_TIME = 60 * 60 * 1000; // 1 hour in milliseconds

// Help menu
const HELP_MESSAGE = `🤖 *Tharuka's AI Assistant - Help Menu*

*Available commands:*
• --help : Show this help menu
• --reset : Reset conversation (allows bot to reply again)
• !ai <question> : Ask any general question to AI

*About this bot:*
I'm Tharuka's personal AI assistant powered by Llama-3. When Tharuka is busy or unavailable, I'm here to help!

*What I can do:*
• Answer your questions
• Take messages for Tharuka
• Provide general assistance

*Example:*
!ai What is the capital of France?

*Note:* I will only reply up to ${MAX_REPLIES} times in a row to avoid spam. Use --reset if you need more help later.`;

client.on('message', async msg => {
    // Ignore messages sent by yourself (fromMe = true)
    if (msg.fromMe) {
        return;
    }

    // Ignore old messages (messages received before bot started)
    const msgTimestamp = msg.timestamp * 1000; // Convert to milliseconds
    if (botStartTime && msgTimestamp < botStartTime) {
        return;
    }

    // Ignore status updates, broadcasts, and non-chat messages
    if (msg.isStatus || msg.from === 'status@broadcast' || msg.broadcast) {
        return;
    }

    // Only process messages from personal chats (ends with @c.us)
    if (!msg.from.endsWith('@c.us')) {
        return;
    }

    const chat = await msg.getChat();
    
    // Only reply to personal chats (not groups or business chats)
    if (chat.isGroup || chat.isBusiness) {
        return;
    }

    // Get sender's number and check if it's in the ignored list
    const senderNumber = msg.from.replace('@c.us', '');
    if (ignoredNumbers.includes(senderNumber)) {
        return;
    }

    const messageText = msg.body.trim().toLowerCase();

    // Handle --help command (always works, even after limit)
    if (messageText === '--help' || messageText === 'help' || messageText === '-help') {
        await msg.reply(HELP_MESSAGE);
        return;
    }

    // Handle --reset command (always works, even after limit)
    if (messageText === '--reset' || messageText === 'reset' || messageText === '-reset') {
        replyTracker.delete(senderNumber);
        await msg.reply('✅ Conversation reset! I will now reply to your messages again.');
        return;
    }

    // Handle !ai command (always works, even after limit)
    if (messageText.startsWith('!ai ')) {
        const question = msg.body.trim().substring(4).trim();
        if (!question) {
            await msg.reply('Please provide a question after !ai\n\nExample: !ai What is the capital of France?');
            return;
        }

        try {
            const response = await axios.post(
                "https://api.groq.com/openai/v1/chat/completions",
                {
                    model: "llama-3.1-8b-instant",
                    messages: [
                        { role: "system", content: "You are a helpful AI assistant. Answer the user's question clearly and concisely." },
                        { role: "user", content: question }
                    ]
                },
                {
                    headers: {
                        "Authorization": `Bearer ${GROQ_API_KEY}`,
                        "Content-Type": "application/json"
                    }
                }
            );

            await msg.reply(response.data.choices[0].message.content);
        } catch (err) {
            console.error('API Error:', err.response?.status, err.response?.data || err.message);
            await msg.reply('Sorry, I encountered an error processing your question.');
        }
        return;
    }

    // Check reply count for this user
    const now = Date.now();
    let userData = replyTracker.get(senderNumber);

    if (userData) {
        // Reset if more than 1 hour has passed
        if (now - userData.firstReplyTime > RESET_TIME) {
            userData = { count: 0, firstReplyTime: now };
        }
        
        // Stop replying if max replies reached
        if (userData.count >= MAX_REPLIES) {
            return;
        }
    } else {
        userData = { count: 0, firstReplyTime: now };
    }

    try {
        const response = await axios.post(
            "https://api.groq.com/openai/v1/chat/completions",
            {
                model: "llama-3.1-8b-instant",
                messages: [
                    { role: "system", content: "You are Tharuka's personal AI assistant, powered by Llama-3. Tharuka is currently not available or busy right now. Be friendly and helpful. If someone has a message for Tharuka, acknowledge it and let them know you'll pass it along. If they have questions you can help with, assist them. Always mention that he will get back to them when available. Use 'he/him' pronouns when referring to Tharuka. At the end of your first reply, mention that they can type --help to see available options." },
                    { role: "user", content: msg.body }
                ]
            },
            {
                headers: {
                    "Authorization": `Bearer ${GROQ_API_KEY}`,
                    "Content-Type": "application/json"
                }
            }
        );

        msg.reply(response.data.choices[0].message.content);

        // Update reply count
        userData.count++;
        replyTracker.set(senderNumber, userData);

    } catch (err) {
        console.error('API Error:', err.response?.status, err.response?.data || err.message);
        msg.reply('Sorry, I encountered an error processing your request.');
    }
});

client.initialize();