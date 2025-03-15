require("dotenv").config();
const express = require("express");
const axios = require("axios");
const NodeCache = require("node-cache");
const cors = require("cors");
const rateLimit = require('express-rate-limit');

const app = express();
const liveCache = new NodeCache(); // Cache expires in 15 minutes (should be good time : 10000 quota -> 24*60 = 1440 minutes in a day)
const staleLiveCaceh = new NodeCache(); // Backup cache to remove loading icon

const channelAvatarCache = new NodeCache({stdTTL : 24 * 60 * 60}); // Cache for 24 hours

const subscriberCountCache = new NodeCache({stdTTL :30 * 60}); // Cache for 30 minutes

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

const { Logtail } = require("@logtail/node");
const winston = require("winston");
const { LogtailTransport } = require("@logtail/winston");

// Initialize Logtail with your Source Token
const logtail = new Logtail(process.env.LOGTAIL_TOKEN, {
    endpoint: `https://${process.env.LOGTAIL_ENDPOINT}`,
});

// Create a Winston logger with Logtail as a transport
const logger = winston.createLogger({
  level: "info",
  format: winston.format.json(),
  transports: [
    new LogtailTransport(logtail),    // Logs to Logtail
  ],
});

const puppeteerArgs = process.env.NODE_ENV === "production" ? [
    "--disable-setuid-sandbox",
    "--no-sandbox",
    "--single-process",
    "--no-zygote",
    "--disable-gpu"
] : [];

const QUERY = "soulcity"; // Default search query
const MAX_RECORDS = 50; // Maximum number of records to fetch (Avoid A Lot of time to fetch data)

puppeteer.use(StealthPlugin());

const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // Limit each IP to 10 requests per windowMs
  message: "Too many requests, please try again later.",
});

app.use('/api', limiter);

app.use(cors());

app.set('trust proxy', 1);

const expiredAvatarsQueue = new Set();
const expiredSubQueue = new Set();

let isProcessingQueue = false;

async function processAvatarQueue() {
    if (isProcessingQueue) return; // If already processing, let it finish current batch

    isProcessingQueue = true;

    let browser;

    try {
        browser = await puppeteer.launch({ 
            headless: true, 
            args: puppeteerArgs,
            executablePath:
                process.env.NODE_ENV === "production"
                    ? process.env.PUPPETEER_EXECUTABLE_PATH
                    : puppeteer.executablePath(),
        });

        const page = await browser.newPage();

        while (expiredAvatarsQueue.size > 0) {
            const channelId = [...expiredAvatarsQueue][0]; // Get first item
            const channelUrl = `https://www.youtube.com/${channelId}`;

            try {
                await page.goto(channelUrl, { waitUntil: "networkidle2" });
            } catch (error) {
                logger.error(`Navigation Error (${error.name}) for ${channelId}`, { error });
                console.error(`Navigation Error (${error.name}) for ${channelId}`);
                expiredAvatarsQueue.delete(channelId);
                continue; // Skip to the next item
            }

            try {
                const avatarUrl = await page.evaluate(() => {
                    return document.querySelector("yt-avatar-shape img")?.src || "";
                });

                if (avatarUrl) {
                    channelAvatarCache.set(channelId, avatarUrl);
                }
            } catch (error) {
                logger.error(`Evaluation Error (${error.name}) for ${channelId}`, { error });
                console.error(`Evaluation Error (${error.name}) for ${channelId}`);
            }

            expiredAvatarsQueue.delete(channelId);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    } catch (error) {
        logger.error(`Browser Launch Error (${error.name})`, { error });
        console.error(`Browser Launch Error (${error.name})`);
    } finally {
        if (browser) await browser.close();
        isProcessingQueue = false;
    }
}

async function processSubQueue() {
    if (isProcessingQueue) return; // If already processing, let it finish current batch

    isProcessingQueue = true;

    let browser;
    try {
        browser = await puppeteer.launch({ 
            headless: true, 
            args: puppeteerArgs,
            executablePath:
                process.env.NODE_ENV === "production"
                    ? process.env.PUPPETEER_EXECUTABLE_PATH
                    : puppeteer.executablePath(),
        });

        const page = await browser.newPage();

        while (expiredSubQueue.size > 0) {
            const channelId = [...expiredSubQueue][0]; // Get first item
            const channelUrl = `https://www.youtube.com/${channelId}`;

            try {
                await page.goto(channelUrl, { waitUntil: "networkidle2" });
            } catch (error) {
                console.error(`Navigation Error (${error.name}) for ${channelId}`);
                expiredSubQueue.delete(channelId);
                logger.error(`Navigation Error (${error.name}) for ${channelId}`, {error})
                continue;
            }

            let subCount = 0;
            try {
                subCount = await page.evaluate(() => {
                    let subs = 0;
                    const subElement = document.querySelectorAll(".yt-content-metadata-view-model-wiz__metadata-row")[1];

                    if (!subElement) {
                        console.warn('Subscription element not found.');
                        return 0;
                    }

                    const subString = subElement.querySelector('span.yt-core-attributed-string')?.innerText || "0 subscribers";

                    if (subString) {
                        let match = subString.trim().match(/([\d,.]+)([KMB]?)/);

                        if (!match) {
                            console.warn('No valid subscription count found.');
                            return 0;
                        }

                        let num = parseFloat(match[1].replace(/,/g, ''));
                        let suffix = match[2];
                        let multiplier = suffix === "K" ? 1_000 : suffix === "M" ? 1_000_000 : suffix === "B" ? 1_000_000_000 : 1;

                        subs = num * multiplier;
                    }

                    return subs;
                });

                if (subCount) {
                    subscriberCountCache.set(channelId, subCount);
                    console.log(`Updated subcount for ${channelId}: ${subCount}`);
                }
            } catch (error) {
                console.error(`Evaluation Error (${error.name}) for ${channelId}`);
                logger.error(`Evaluation Error (${error.name}) for ${channelId}`, {error});
            }

            expiredSubQueue.delete(channelId);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        await page.close();
    } catch (error) {
        console.error(`Unexpected Error (${error.name}) in processSubQueue`);
        logger.error(`Unexpected Error (${error.name}) in processSubQueue`, {error});
    } finally {
        if (browser) {
            try {
                await browser.close();
            } catch (closeError) {
                console.error(`Browser Close Error (${closeError.name})`);
                 logger.error(`Browser Close Error (${closeError.name})`, {error});
            }
        }
        isProcessingQueue = false;
    }
}

// Function to scrape YouTube for live videos
async function fetchLiveVideos(QUERY) {
    let browser;
    try {
        browser = await puppeteer.launch({ 
            headless: true, 
            args: puppeteerArgs,
            executablePath:
                process.env.NODE_ENV === "production"
                    ? process.env.PUPPETEER_EXECUTABLE_PATH
                    : puppeteer.executablePath(),
        });

        const page = await browser.newPage();

        // Set user agent to mimic a real browser
        await page.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
        );

        const searchURL = `https://www.youtube.com/results?search_query=${QUERY}&sp=EgJAAQ%253D%253D`;

        try {
            await page.goto(searchURL, { waitUntil: "networkidle2" });
        } catch (error) {
            console.error("Error navigating to YouTube:", error);
            await browser.close();
            logger.error("Error navigating to YouTube", {error});
            return [];
        }

        try {
            await page.waitForSelector("#video-title", { timeout: 5000 });
        } catch (error) {
            console.warn("No videos found for query.", QUERY);
            await browser.close();
            logger.error("No videos found for query.", {error});
            return [];
        }

        const maxScrolls = MAX_RECORDS / 10;
        let lastHeight = 0;
        
        for (let i = 0; i < maxScrolls; i++) {
            try {
                await page.evaluate(() => window.scrollBy(0, document.documentElement.scrollHeight));
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                let newHeight = await page.evaluate(() => document.documentElement.scrollHeight);
                if (newHeight === lastHeight) {
                    break;
                }
                lastHeight = newHeight;
            } catch (error) {
                console.error("Error during scrolling:", error);
                logger.error("Error during scrolling page.", {error});
                break;
            }
        }

        // Extract video details
        let videos = [];
        try {
            videos = await page.evaluate((query, maxRecords) => {
                const results = [];
                document.querySelectorAll("ytd-video-renderer, ytd-grid-video-renderer").forEach((video) => {
                    if (results.length >= maxRecords) return;

                    const title = video.querySelector("#video-title")?.textContent.trim();
                    const url = video.querySelector("#video-title")?.href;
                    const channelName = video.querySelector("#channel-name a")?.textContent.trim();
                    const channelId = video.querySelector("#channel-name a")?.href.split("/").pop();
                    const videoId = url?.split("v=")[1]?.split("&")[0];
                    const channelAvatar = video.querySelector("#channel-info #channel-thumbnail yt-img-shadow img")?.src;
                    const channelUrl = video.querySelector("#channel-name a")?.href;

                    let viewers = 0;
                    const viewerElement = video.querySelector("span.ytd-video-meta-block, span.ytd-thumbnail-overlay-time-status-renderer");
                    if (viewerElement) {
                        let rawViewers = viewerElement.textContent.trim();
                        let match = rawViewers.match(/([\d,.]+)([KMB]?)/);

                        if (match) {
                            let num = parseFloat(match[1].replace(/,/g, ''));
                            let suffix = match[2];
                            let multiplier = suffix === "K" ? 1_000 : suffix === "M" ? 1_000_000 : suffix === "B" ? 1_000_000_000 : 1;
                            viewers = num * multiplier;
                        }
                    }

                    if (title.toLowerCase().includes(query)) {
                        results.push({ videoId, title, url, channelName, channelId, viewers, channelUrl, channelAvatar });
                    }
                });

                return results;
            }, QUERY, MAX_RECORDS);
        } catch (error) {
            console.error("Error extracting video details", error);
            logger.error("Error Evaluating Opened Page", {error});
        }

        await browser.close();

        // Ensure unique results
        const uniqueVideos = videos.filter((v, i, self) => i === self.findIndex(t => t.videoId === v.videoId));

        uniqueVideos.forEach((video) => {
            if (!channelAvatarCache.get(video.channelId)) {
                expiredAvatarsQueue.add(video.channelId);
            }

            if (!subscriberCountCache.get(video.channelId)) {
                expiredSubQueue.add(video.channelId);
            }
        });

        return uniqueVideos;
    } catch (error) {
        console.error("Unexpected error in fetchLiveVideos:", error);
        logger.error("Unexpected error in fetchLiveVideos.", {error})
        return [];
    } finally {
        if (browser) {
            try {
                await browser.close();
            } catch (closeError) {
                console.error("Error closing the browser:", closeError);
                logger.error("Error closing the browser.", {closeError})
            }
        }
    }
}

// API endpoint with caching & pagination
app.get("/api/live-videos", async (req, res) => {
    try {
        let videos = liveCache.get("liveVideos") || [];

        // Properly map over the array to update avatars
        videos = videos.map((video) => ({
            ...video,
            channelAvatar: channelAvatarCache.get(video.channelId) || "",
            channelSubs: subscriberCountCache.get(video.channelId) || 0
        }));

        res.json({ success: true, videos });
    } catch (error) {
        console.error("Error fetching videos:", error);
        res.status(500).json({ success: false, message: "Error fetching videos" });
        logger.error(error);
    }
});

let isRebuilding = false;

// Function to rebuild cache in the background
async function rebuildLiveCache() {
    if (isRebuilding) return; // Prevent multiple rebuilds
    isRebuilding = true;

    if (isProcessingQueue) return;

    isProcessingQueue = true;

    const newData = await fetchLiveVideos(QUERY); // Simulate data fetching

    // Rebuild New Cache Every 5 minutes
    staleLiveCaceh.flushAll();
    staleLiveCaceh.set("liveVideos", newData); // Atomically replace cache

    // Update new cache to serving cache
    liveCache.flushAll();
    liveCache.set('liveVideos', newData);

    isRebuilding = false;
    isProcessingQueue = false;
}

// Schedule cache rebuild every 30 minutes
setInterval(rebuildLiveCache, 5 * 60 * 1000);

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);

    logger.info("Server Started", { port: 3000 });

    await rebuildLiveCache();

    // Update Channel Avatar Cache In Intervals
    setInterval(() => {
        if (isProcessingQueue) {
            return ;
        } 

        if (expiredAvatarsQueue.size > 0) processAvatarQueue() ;
        if (expiredSubQueue.size > 0) processSubQueue() ;
    }, 10000);
});
