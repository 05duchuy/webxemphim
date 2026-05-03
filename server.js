require('dotenv').config();
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const bigInt = require("big-integer"); // Thư viện hỗ trợ số lớn
const express = require('express');
const cors = require('cors');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(express.json());

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const stringSession = new StringSession(process.env.TELEGRAM_SESSION);

const loadJSON = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } 
    catch (e) { return []; }
};

(async () => {
    const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
    await client.start();
    
    console.log("------------------------------------------");
    console.log(`>>> HUY MOVIE: SERVER READY - PORT: ${PORT}`);
    console.log("------------------------------------------");

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

                // Dùng bigInt để làm offset - Khắc phục lỗi .divide
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

                const iterable = client.iterDownload({
                    file: media,
                    requestSize: 1024 * 512,
                });

                for await (const chunk of iterable) {
                    res.write(chunk);
                }
            }
            res.end();
        } catch (error) {
            console.error("Stream Error:", error);
            if (!res.headersSent) res.status(500).send("Lỗi luồng");
        }
    });

    app.listen(PORT);
})();