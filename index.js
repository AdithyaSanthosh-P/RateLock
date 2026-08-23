import express from 'express'
import Redis from 'ioredis'

// Create a Redis instance.
// By default, it will connect to localhost:6379.

const redis = new Redis();
const app = express()

redis.defineCommand("checkAndDecrementTokens", {
    numberOfKeys: 1,
    lua: `
        local tokens = redis.call('GET', KEYS[1])
        if tonumber(tokens) >= tonumber(ARGV[1]) then
        redis.call('DECRBY', KEYS[1], ARGV[1])
        return 1
        else
        return 0
        end
    `
});

app.use(async (req, res, next) => {
    //hardcoded users and endponts
    const userId = 1;
    const endpoint = "endpoint-a";
    const initialTokens = 10;

    //need to buld the eys and cost here
    const key = `ratelock:tokens:${userId}:${endpoint}`
    const cost = 1;

    try {
        const exists = await redis.exists(key);
        if (!exists) {
            await redis.set(key, initialTokens);
        }

        //f both new and exstng user:
        const allowed = await redis.checkAndDecrementTokens(key, cost);

        if (allowed) {
            next(); // Continue to route handler
        } else {
            res.status(429).send("Rate limit exceeded");
        }

    } catch (err) {
        console.error(err);
        res.status(500).send("Server error");
    }
})


app.get('/', (req, res) => {
    res.send("Random : " + Math.random()*100);  
})

app.listen(3000, () => {
  console.log('Server is running on http://localhost:3000')
})

