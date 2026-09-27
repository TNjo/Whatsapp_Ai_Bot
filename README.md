# 🤖 WhatsApp AI Assistant - Powered by Llama-3

> **New: WhatsApp AI Business Bot + Order Management platform** — built on the official WhatsApp Cloud API, with a business dashboard for products, conversations and orders. See [`platform/`](platform/README.md). The guide below covers the original personal auto-reply bot.

A personal AI assistant for WhatsApp that auto-replies to your messages when you're busy. Built with Node.js, whatsapp-web.js, and Groq API (Llama-3).

---

## 🎯 Features

- ✅ Auto-replies to personal chats when you're busy
- ✅ Powered by Llama-3 AI via Groq API (free & fast!)
- ✅ Limits replies to avoid spam (max 3 per person)
- ✅ Supports commands like `--help`, `--reset`, `!ai <question>`
- ✅ Ignores groups, business chats & status updates
- ✅ Remembers session (scan QR only once!)

---

## 🛠️ Tech Stack

| Technology | Purpose |
|------------|---------|
| Node.js | Runtime environment |
| whatsapp-web.js | WhatsApp Web automation |
| Groq API | Llama-3 LLM provider |
| Puppeteer | Headless Chrome browser |
| Axios | HTTP client for API calls |
| dotenv | Environment variable management |

---

## 📦 Installation

### Step 1: Clone & Initialize

```bash
mkdir whatsapp-ai-bot
cd whatsapp-ai-bot
npm init -y
```

### Step 2: Install Dependencies

```bash
npm install whatsapp-web.js qrcode-terminal axios dotenv
```

**What each package does:**

| Package | Purpose |
|---------|---------|
| `whatsapp-web.js` | Automates WhatsApp Web using Puppeteer |
| `qrcode-terminal` | Displays QR code in terminal for WhatsApp login |
| `axios` | Makes HTTP requests to Groq API |
| `dotenv` | Loads environment variables from `.env` file |

### Step 3: Create `.env` file

```env
GROQ_API_KEY=your_groq_api_key_here
```

> 💡 Get your free API key from: https://console.groq.com
>
> **Why Groq?** It's free, extremely fast (500+ tokens/sec), and provides access to Llama-3 models!

---

## 📝 Full Code with Explanations

Create a file named `bot.js`:

### Part 1: Dependencies & Configuration

```javascript
require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const axios = require('axios');
const qrcode = require('qrcode-terminal');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
```

**Explanation:**

| Code | Purpose |
|------|---------|
| `dotenv.config()` | Loads variables from `.env` file into `process.env` |
| `Client` | Main WhatsApp client class that handles all WhatsApp operations |
| `LocalAuth` | Authentication strategy that saves session locally (no QR scan on restart!) |
| `axios` | HTTP client for API calls |
| `qrcode-terminal` | Renders QR code in terminal |

---

### Part 2: WhatsApp Client Setup

```javascript
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { headless: true }
});
```

**Explanation:**

| Option | Purpose |
|--------|---------|
| `LocalAuth()` | Saves your WhatsApp session in `.wwebjs_auth` folder. Without this, you'd need to scan QR code every time! |
| `headless: true` | Runs Chrome in background without visible window. Set to `false` for debugging. |

---

### Part 3: Rate Limiting & Configuration

```javascript
let botStartTime = null;
const replyTracker = new Map();
const MAX_REPLIES = 3;
const RESET_TIME = 60 * 60 * 1000; // 1 hour in milliseconds
```

**Explanation:**

| Variable | Purpose |
|----------|---------|
| `botStartTime` | Tracks when bot started to ignore old unread messages |
| `replyTracker` | JavaScript Map to store reply count per phone number |
| `MAX_REPLIES = 3` | Bot stops auto-replying after 3 messages to prevent spam |
| `RESET_TIME` | Reply counter resets after 1 hour |

---

### Part 4: Help Menu

```javascript
const HELP_MESSAGE = `🤖 *AI Assistant - Help Menu*

*Commands:*
• --help : Show this menu
• --reset : Reset conversation
• !ai <question> : Ask any question

I'll reply up to ${MAX_REPLIES} times to avoid spam.`;
```

**Explanation:**

- Template literal with WhatsApp markdown formatting (`*bold*`)
- `${MAX_REPLIES}` dynamically inserts the limit value

---

### Part 5: Event Handlers

```javascript
client.on('qr', qr => qrcode.generate(qr, { small: true }));

client.on('ready', () => {
    botStartTime = Date.now();
    console.log('Bot is ready!');
});
```

**Explanation:**

| Event | When it fires | What we do |
|-------|---------------|------------|
| `'qr'` | When QR code is generated | Display it in terminal for scanning |
| `'ready'` | When WhatsApp is connected | Record start time to ignore old messages |

- `{ small: true }` generates compact QR code that fits in terminal

---

### Part 6: Message Handler - Filtering

```javascript
client.on('message', async msg => {
    // 1. Ignore own messages
    if (msg.fromMe) return;
    
    // 2. Ignore old messages (before bot started)
    if (botStartTime && msg.timestamp * 1000 < botStartTime) return;
    
    // 3. Ignore status updates & broadcasts
    if (msg.isStatus || msg.broadcast) return;
    
    // 4. Only process personal chats (@c.us suffix)
    if (!msg.from.endsWith('@c.us')) return;
    
    // 5. Ignore groups & business accounts
    const chat = await msg.getChat();
    if (chat.isGroup || chat.isBusiness) return;
```

**Explanation:**

| Check | Purpose |
|-------|---------|
| `msg.fromMe` | True if YOU sent the message (prevents replying to yourself) |
| `msg.timestamp * 1000` | Message timestamp in milliseconds. Compare with `botStartTime` to skip old unread messages |
| `msg.isStatus` | True for WhatsApp status/story updates |
| `msg.broadcast` | True for broadcast list messages |
| `@c.us` suffix | Personal chat IDs end with `@c.us`, groups end with `@g.us` |
| `chat.isGroup` / `chat.isBusiness` | Additional checks for group and business chats |

---

### Part 7: Command Handlers

```javascript
    const senderNumber = msg.from.replace('@c.us', '');
    const messageText = msg.body.trim().toLowerCase();

    // --help command
    if (messageText === '--help') {
        await msg.reply(HELP_MESSAGE);
        return;
    }

    // --reset command
    if (messageText === '--reset') {
        replyTracker.delete(senderNumber);
        await msg.reply('✅ Conversation reset!');
        return;
    }

    // !ai command - Ask AI anything
    if (messageText.startsWith('!ai ')) {
        const question = msg.body.substring(4).trim();
        const response = await askAI(question, "You are a helpful AI assistant.");
        await msg.reply(response);
        return;
    }
```

**Explanation:**

| Code | Purpose |
|------|---------|
| `senderNumber` | Extracts phone number by removing `@c.us` suffix |
| `messageText.toLowerCase()` | Case-insensitive command matching |
| `--help` | Shows available commands |
| `--reset` | Clears reply counter so bot responds again |
| `!ai <question>` | Bypasses reply limit, lets users ask unlimited AI questions |
| `msg.body.substring(4)` | Removes `!ai ` prefix to get the actual question |

---

### Part 8: Reply Limiting Logic

```javascript
    // Get or create user data
    let userData = replyTracker.get(senderNumber) || { count: 0, time: Date.now() };
    
    // Reset counter if 1 hour passed
    if (Date.now() - userData.time > RESET_TIME) {
        userData = { count: 0, time: Date.now() };
    }
    
    // Stop if limit reached
    if (userData.count >= MAX_REPLIES) return;
```

**Explanation:**

| Code | Purpose |
|------|---------|
| `replyTracker.get(senderNumber)` | Retrieves stored data for this phone number |
| `\|\| { count: 0, time: Date.now() }` | Default value for new users |
| Time check | Resets counter after 1 hour of inactivity |
| `count >= 3` | Bot silently stops replying (no spam!) |

---

### Part 9: AI Response & Counter Update

```javascript
    // Generate AI response
    const systemPrompt = "You are [Your Name]'s personal AI assistant powered by Llama-3. [Your Name] is currently busy. Be helpful and mention they can type --help for options.";
    const response = await askAI(msg.body, systemPrompt);
    await msg.reply(response);
    
    // Update counter
    userData.count++;
    replyTracker.set(senderNumber, userData);
});
```

**Explanation:**

| Code | Purpose |
|------|---------|
| `systemPrompt` | Instructions that define AI's personality and behavior |
| `askAI()` | Helper function that calls Groq API |
| `await msg.reply()` | Sends reply to the chat |
| `userData.count++` | Increments reply counter |
| `replyTracker.set()` | Saves updated counter back to Map |

---

### Part 10: AI Helper Function

```javascript
async function askAI(question, systemPrompt) {
    try {
        const response = await axios.post(
            "https://api.groq.com/openai/v1/chat/completions",
            {
                model: "llama-3.1-8b-instant",
                messages: [
                    { role: "system", content: systemPrompt },
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
        return response.data.choices[0].message.content;
    } catch (err) {
        console.error('API Error:', err.message);
        return 'Sorry, I encountered an error.';
    }
}
```

**Explanation:**

| Code | Purpose |
|------|---------|
| Groq API URL | Uses OpenAI-compatible format (`/v1/chat/completions`) |
| `model: "llama-3.1-8b-instant"` | Fast, lightweight Llama-3 model |
| `system` role | Sets AI behavior/personality |
| `user` role | The actual question/message |
| `Bearer ${GROQ_API_KEY}` | Authentication header |
| `response.data.choices[0].message.content` | Extracts AI's reply from response |
| `try/catch` | Graceful error handling |

---

### Part 11: Start the Bot

```javascript
client.initialize();
```

**Explanation:**

- Launches Puppeteer browser, opens WhatsApp Web, and starts listening for events

---

## 🚀 Running the Bot

```bash
node bot.js
```

1. QR code appears in terminal
2. Open WhatsApp on phone → **Settings** → **Linked Devices** → **Link a Device**
3. Scan the QR code
4. Bot is now running! 🎉

---

## 📊 Message Flow Diagram

```
User sends message
        ↓
Is it from me? ──────────────────→ YES → Ignore
        ↓ NO
Is it old message? ──────────────→ YES → Ignore
        ↓ NO
Is it status/broadcast? ─────────→ YES → Ignore
        ↓ NO
Is it group/business? ───────────→ YES → Ignore
        ↓ NO
Is it a command? ────────────────→ YES → Execute command
        ↓ NO
Reply limit reached? ────────────→ YES → Ignore
        ↓ NO
Generate AI response → Send reply → Increment counter
```

---

## 🔧 Available Commands

| Command | Description |
|---------|-------------|
| `--help` | Show help menu with available commands |
| `--reset` | Reset conversation (allows bot to reply again) |
| `!ai <question>` | Ask any general question to AI (unlimited) |

**Examples:**

```
!ai What is the capital of France?
!ai How do I cook pasta?
!ai Explain quantum physics in simple terms
```

---

## ⚠️ Important Notes

### Deployment

This bot runs on your **local machine** (not serverless). For 24/7 deployment, use:

| Platform | Cost | Notes |
|----------|------|-------|
| Railway | ~$5/month | Easy deployment |
| Render | ~$7/month | Simple setup |
| DigitalOcean | $4-6/month | Full control |
| Oracle Cloud Free | Free | Always-free VM |

> ❌ **Vercel/Netlify won't work** - They're serverless and can't run long-running processes with Puppeteer.

### Session Management

- First run requires QR scan
- After that, session is saved in `.wwebjs_auth` folder
- Delete this folder to re-authenticate

### Rate Limits

- Groq free tier: ~30 requests/minute (generous!)
- Bot limits: 3 auto-replies per person per hour

### WhatsApp Updates

The `whatsapp-web.js` library may break occasionally when WhatsApp updates their web interface. Check the [GitHub repository](https://github.com/pedroslopez/whatsapp-web.js) for fixes.

---

## 🔗 Resources

- **whatsapp-web.js**: https://github.com/pedroslopez/whatsapp-web.js
- **Groq Console**: https://console.groq.com
- **Groq Documentation**: https://console.groq.com/docs

---

## 📄 License

MIT License - Feel free to use and modify!

---

## 🤝 Contributing

Pull requests are welcome! For major changes, please open an issue first.

---

**Made with ❤️ by Tharuka**
