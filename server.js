require("dotenv").config();
const express = require("express");
const axios = require("axios");
const NodeCache = require("node-cache");
const cors = require("cors");
const rateLimit = require('express-rate-limit');

const app = express();
const liveCache = new NodeCache({ stdTTL: 15 * 60 }); // Cache expires in 15 minutes (should be good time : 10000 quota -> 24*60 = 1440 minutes in a day)
const channelAvatarCache = new NodeCache({ stdTTL: 24 * 60 * 60}); // Cache for 24 hours
const subscriberCountCache = new NodeCache({stdTTL: 30 * 60}); // Cache for 30 minutes
const API_KEY = process.env.YOUTUBE_API_KEY;
const BASE_URL = "https://www.googleapis.com/youtube/v3/search";
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

const QUERY = "game"; // Default search query
const MAX_RECORDS = 10; // Maximum number of records to fetch (Avoid A Lot of time to fetch data)

puppeteer.use(StealthPlugin());

const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 500, // Limit each IP to 10 requests per windowMs
  message: "Too many requests, please try again later.",
});

app.use('/api', limiter);

app.use(cors());

app.set('trust proxy', 1);

app.get("/api/videos", async (req, res) => {
  let query = "soulcity"; // Default search query
  let page = parseInt(req.query.page) || 1;
  let limit = 12; // Default to 10 videos per page

  // Check cache
  if (liveCache.has(query)) {
    console.log("Serving from cache:", query);
    const cachedVideos = liveCache.get(query);
    const paginatedVideos = cachedVideos.slice((page - 1) * limit, page * limit);
    return res.json({
      videos: paginatedVideos,
      totalVideos: cachedVideos.length,
      totalPages: Math.ceil(cachedVideos.length / limit),
      currentPage: page,
    });
  }

  try {
    const response = await axios.get(BASE_URL, {
      params: {
        part: "snippet",
        type: "video",
        eventType: "live",
        q: query,
        maxResults: 50, // Fetch up to 50 videos at once
        key: API_KEY,
        videoCategoryId : 20 // Gaming Category Video Only
      },
    });

    let videos = response.data.items;

    // Filter videos based on title containing the keywords (case-insensitive)
    const keywords = ["lifeinsoulcity", "soulcity", "soulcitybyechorp"];
    videos = videos.filter(video =>
      keywords.some(keyword => video.snippet.title.toLowerCase().includes(keyword.toLowerCase()))
    );

    liveCache.set(query, videos); // Store in cache

    console.log("Fetching from API:", query);
    console.log('Data :', videos);

    // Apply pagination
    const totalVideos = videos.length;
    const totalPages = Math.ceil(totalVideos / limit);
    const paginatedVideos = videos.slice((page - 1) * limit, page * limit);

    res.json({
      videos: paginatedVideos,
      totalVideos,
      totalPages,
      currentPage: page,
    });
    console.log("Fetching from API:", query);
  } catch (error) {
    console.error("Error fetching videos:", error);
    res.status(500).json({ error: "Failed to fetch videos" });
  }
});

const expiredAvatarsQueue = new Set();
const expiredSubQueue = new Set();

let isProcessingQueue = false;

async function processAvatarQueue() {
    if (isProcessingQueue) return; // If already processing, let it finish current batch

    isProcessingQueue = true;

    console.log('Started Processing Queue;')

    const browser = await puppeteer.launch({ 
        headless: true, 
        args: [
            "--disable-setuid-sandbox",
            "--no-sandbox",
            "--single-process",
            "--no-zygote",
        ],
        executablePath:
            process.env.NODE_ENV === "production"
                ? process.env.PUPPETEER_EXECUTABLE_PATH
                : puppeteer.executablePath(),
    });
    const page = await browser.newPage();

    while (expiredAvatarsQueue.size > 0) {  // Keep running until queue is empty
        const channelId = [...expiredAvatarsQueue][0]; // Get first item

        const channelUrl = `https://www.youtube.com/${channelId}`

        console.log(`Updating avatar for ${channelId}...`);
        try {
            await page.goto(channelUrl, { waitUntil: "networkidle2" });
            const avatarUrl = await page.evaluate(() => {
                return document.querySelector("yt-avatar-shape img")?.src || "";
            });

            if (avatarUrl) {
                channelAvatarCache.set(channelId, avatarUrl);
                console.log(`Updated avatar for ${channelId}: ${avatarUrl}`);
            }
        } catch (error) {
            console.error(`Error refreshing avatar for ${channelId}:`, error);
        }

        expiredAvatarsQueue.delete(channelId); // Remove from queue
    }

    await page.close();
    await browser.close();

    isProcessingQueue = false;
}

async function processSubQueue() {
    if (isProcessingQueue) return; // If already processing, let it finish current batch

    isProcessingQueue = true;

    console.log('Started Processing Queue;')

    const browser = await puppeteer.launch({ 
        headless: true, 
        args: [
            "--disable-setuid-sandbox",
            "--no-sandbox",
            "--single-process",
            "--no-zygote",
        ],
        executablePath:
            process.env.NODE_ENV === "production"
                ? process.env.PUPPETEER_EXECUTABLE_PATH
                : puppeteer.executablePath(),
    });
    const page = await browser.newPage();

    while (expiredSubQueue.size > 0) {  // Keep running until queue is empty
        const channelId = [...expiredSubQueue][0]; // Get first item

        const channelUrl = `https://www.youtube.com/${channelId}`

        console.log(`Updating subcount for ${channelId}...`);
        try {
            await page.goto(channelUrl, { waitUntil: "networkidle2" });

            const subCount = await page.evaluate(() => {
                let subs = 0;
                const subElement = (document.querySelectorAll(".yt-content-metadata-view-model-wiz__metadata-row")[1]);

                if (!subElement) {
                    console.log('Failed To Found Sub Element');
                    return 0;
                }

                const subString = subElement.querySelector('span.yt-core-attributed-string')?.innerText || "0 subscribers";

                if (subString) {
                    let rawViewers = subString.trim();

                    let match = rawViewers.match(/([\d,.]+)([KMB]?)/);
        
                    if (!match) {
                        subs = 0;
                        console.log('No Sub Count found');
                        return 0;
                    } 
                    
                    let num = parseFloat(match[1].replace(/,/g, '')); // Remove commas and convert to number
                    let suffix = match[2]; // Get the suffix (K, M, B)

                    let multiplier = 1;
                    if (suffix === "K") multiplier = 1_000;
                    else if (suffix === "M") multiplier = 1_000_000;
                    else if (suffix === "B") multiplier = 1_000_000_000;

                    subs = num * multiplier;

                    console.log(subs); // Output: 1200
                }

                return subs;
            });

            if (subCount) {
                subscriberCountCache.set(channelId, subCount);
                console.log(`Updated subcount for ${channelId}: ${subCount}`);
            }
        } catch (error) {
            console.error(`Error refreshing subcount for ${channelId}:`, error);
        }

        expiredSubQueue.delete(channelId); // Remove from queue
    }

    await page.close();
    await browser.close();

    isProcessingQueue = false;
}

// Function to scrape YouTube for live videos
async function fetchLiveVideos(QUERY) {
    console.log("Inside Fetch Live Video Function.");
    const browser = await puppeteer.launch({ 
        headless: true, 
        args: [
            "--disable-setuid-sandbox",
            "--no-sandbox",
            "--single-process",
            "--no-zygote",
        ],
        executablePath:
            process.env.NODE_ENV === "production"
                ? process.env.PUPPETEER_EXECUTABLE_PATH
                : puppeteer.executablePath(),
    });

    console.log('Broser Init');
    
    const page = await browser.newPage();

    console.log('New Empty Page Opened');

    // Set user agent to mimic a real browser
    // await page.setUserAgent(
    //     "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    // );

    // Navigate to YouTube search with "soulcity" and "Live" filter
    console.log(QUERY, MAX_RECORDS)
    const searchURL = `https://www.youtube.com/results?search_query=${QUERY}&sp=EgJAAQ%253D%253D`;
    await page.goto(searchURL, { waitUntil: "networkidle2" });

    // This approach won't throw an error in console. Instead just store an empty string in cache
    try {
        await page.waitForSelector("#video-title", { timeout: 5000 });
    } catch (error) {
        liveCache.flushAll();
        liveCache.set("liveVideos", []); // Store in cache
        await browser.close();
        return [];
    }

    const maxScrolls = MAX_RECORDS / 10; // Adjust this to control how many times it scrolls for more results

    // Scroll down to load more results
    let lastHeight = 0;
    for (let i = 0; i < maxScrolls; i++) {
        console.log(`Scrolling... (${i + 1}/${maxScrolls})`);

        await page.evaluate(() => {
             window.scrollBy(0, document.documentElement.scrollHeight);
        });

        await new Promise(resolve => setTimeout(resolve, 2000));

        let newHeight = await page.evaluate(() => document.documentElement.scrollHeight);

        if (newHeight === lastHeight) {
            console.log("No more content to load");
            break; // Stop if no new content loads
        } 
        lastHeight = newHeight;
    }

    console.log('Scrolling Done.')

    // Extract video details
    const videos = await page.evaluate((query, maxRecords) => {
        console.log("Scraping Started.")
        const results = [];
        document.querySelectorAll("ytd-video-renderer, ytd-grid-video-renderer").forEach((video) => {
            if (results.length >= maxRecords) return; // Stop collecting if limit is reached

            const title = video.querySelector("#video-title")?.textContent.trim();
            const url = video.querySelector("#video-title")?.href;
            const channelName = video.querySelector("#channel-name a")?.textContent.trim();
            const channelId = video.querySelector("#channel-name a")?.href.split("/").pop();
             // Extract videoId from the URL
            const videoId = url?.split("v=")[1]?.split("&")[0];

            // Construct thumbnail URL
            //const thumbnail = videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : "";
            const thumbnail = videoId ? `https://i.ytimg.com/vi_webp/${videoId}/mqdefault.webp` : "";

            const channelAvatar = video.querySelector("#channel-info #channel-thumbnail yt-img-shadow img")?.src; // Channel thumbnail
            
            const channelSubs = 0;

            const channelUrl = video.querySelector("#channel-name a")?.href;

            let viewers = 0;
            const viewerElement = video.querySelector("span.ytd-video-meta-block, span.ytd-thumbnail-overlay-time-status-renderer");
            if (viewerElement) {
                let rawViewers = viewerElement.textContent.trim();

                let match = rawViewers.match(/([\d,.]+)([KMB]?)/);
      
                if (!match) {
                    viewers = 0;
                    console.log('No Viewer Count found');
                    return;
                } 
                
                let num = parseFloat(match[1].replace(/,/g, '')); // Remove commas and convert to number
                let suffix = match[2]; // Get the suffix (K, M, B)

                let multiplier = 1;
                if (suffix === "K") multiplier = 1_000;
                else if (suffix === "M") multiplier = 1_000_000;
                else if (suffix === "B") multiplier = 1_000_000_000;

                viewers = num * multiplier;

                console.log(viewers); // Output: 1200
            }

            if (title.toLowerCase().includes(query)) {
                 results.push({ videoId, title, thumbnail, url, channelName, channelId, viewers, channelUrl, channelAvatar, channelSubs });
            }
        });

        console.log('Results :', results);
        return results;
    }, QUERY, MAX_RECORDS);

    await browser.close();

    console.log('Browser Closed.')

    // Ensure unique results
    const uniqueVideos = videos.filter((v, i, self) => i === self.findIndex(t => t.videoId === v.videoId));

    uniqueVideos.forEach((video) => {
        if (channelAvatarCache.get(video.channelId)) {
        } else {
            console.log('Added Data to Expired Queue');
            expiredAvatarsQueue.add(video.channelId); // Set them expired so that new can be fetched ?
        }

        if (subscriberCountCache.get(video.channelId)) {
        } else {
            console.log('Added Data to Expired Queue');
            expiredSubQueue.add(video.channelId);
        }
    })

    console.log('Fetched Videos : ', uniqueVideos.length);
    liveCache.flushAll();
    liveCache.set("liveVideos", uniqueVideos); // Store in cache

    return uniqueVideos;
}

// API endpoint with caching & pagination
app.get("/api/live-videos", async (req, res) => {
    try {
        let videos = liveCache.get("liveVideos") || await fetchLiveVideos(QUERY);

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
    }
});

app.get("/test", async (req, res) => {
    console.log('Test API is Running');
})

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`)
    await fetchLiveVideos(QUERY)

    // Update Channel Avatar Cache In Intervals
    setInterval(() => {
        if (isProcessingQueue) {
            console.log('Interval Stopped As Already Processing')
            return ;
        } 

        if (expiredAvatarsQueue.size > 0) processAvatarQueue() ;
        if (expiredSubQueue.size > 0) processSubQueue() ;
    }, 10000);
});
