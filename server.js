require('dotenv').config();
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const bigInt = require("big-integer");
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path'); // Thêm path để đọc file chính xác trên server

const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(express.json());

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const stringSession = new StringSession(process.env.TELEGRAM_SESSION);

// Dùng path.join để đảm bảo tìm thấy file trên môi trường Linux của Render
const loadJSON = (file) => {
    try { 
        const filePath = path.join(__dirname, file);
        return JSON.parse(fs.readFileSync(filePath, 'utf8')); 
    } catch (e) { return []; }
};

// Khởi tạo Telegram Client ngoài vòng lặp
const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });

// 1. ĐỊNH NGHĨA CÁC ROUTE TRƯỚC
app.get('/', (req, res) => res.send("HUY MOVIE API IS RUNNING 🚀"));

app.get('/api/movies', (req, res) => res.json(loadJSON('movies.json')));

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const users = loadJSON('users.json');
    const user = users.find(u => u.username === username && u.password === password);
    user ? res.json({ success: true, user: user.name }) : res.status(401).json({ success: false });
});

app.get('/video/:fileId', async (req, res) => {
    const { fileId } = req.params;
    const { range } = req.headers;

    try {
        const movies = loadJSON('movies.json');
        const movie = movies.find(m => m.fileId === fileId);
        if (!movie) return res.status(404).send("Phim không tồn tại");

        const messages = await client.getMessages(bigInt(movie.channelId), { ids: [parseInt(fileId)] });
        if (!messages?.length || !messages[0].media) return res.status(404).send("Media lỗi");

        const media = messages[0].media;
        const fileSize = media.document ? bigInt(media.document.size) : 
                         (media.video ? bigInt(media.video.size) : bigInt(0));

        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = bigInt(parts[0]);
            const end = parts[1] ? bigInt(parts[1]) : fileSize.minus(1);
            const chunksize = end.minus(start).plus(1);

            res.writeHead(206, {
                "Content-Range": `bytes ${start}-${end}/${fileSize}`,
                "Accept-Ranges": "bytes",
                "Content-Length": chunksize.toString(),
                "Content-Type": "video/mp4",
            });

            const iterable = client.iterDownload({
                file: media,
                offset: start, 
                requestSize: 1024 * 512,
            });

            let totalSent = bigInt(0);
            for await (const chunk of iterable) {
                const needToSend = chunksize.minus(totalSent);
                if (needToSend.lesserOrEquals(0)) break;

                if (bigInt(chunk.length).greater(needToSend)) {
                    res.write(chunk.slice(0, needToSend.toJSNumber()));
                    totalSent = totalSent.plus(needToSend);
                    break;
                } else {
                    res.write(chunk);
                    totalSent = totalSent.plus(chunk.length);
                }
            }
        } else {
            res.writeHead(200, {
                "Content-Length": fileSize.toString(),
                "Content-Type": "video/mp4",
                "Accept-Ranges": "bytes",
            });
            const iterable = client.iterDownload({ file: media, requestSize: 1024 * 512 });
            for await (const chunk of iterable) { res.write(chunk); }
        }
        res.end();
    } catch (error) {
        console.error("Stream Error:", error);
        if (!res.headersSent) res.status(500).send("Lỗi luồng");
    }
});

// 2. MỞ CỔNG SERVER NGAY LẬP TỨC
app.listen(PORT, async () => {
    console.log("------------------------------------------");
    console.log(`>>> SERVER LIVE AT: ${PORT}`);
    console.log("------------------------------------------");
    
    // Sau khi server chạy mới bắt đầu kết nối Telegram để Render không báo lỗi Timeout
    try {
        await client.start();
        console.log(">>> TELEGRAM CLIENT CONNECTED!");
    } catch (err) {
        console.error(">>> TELEGRAM CONNECTION FAILED:", err);
    }
});