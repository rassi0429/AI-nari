import { Configuration, OpenAIApi } from "openai"
import axios from "axios"
import { Client, IntentsBitField } from "discord.js";
import { configDotenv } from "dotenv";
configDotenv();

// https://script.google.com/macros/s/AKfycbyT5XyWpHjbAb5gZsw3fMImWtxxQTqFO6-b5w5wYiaQaplt_f443lgVh7YrE7R_Uuoa/exec
const SYS_API = process.env.GAS_URL
const DISCORD_CHANNELS = (process.env.DISCORD_CHANNELS || '').split(',').map(id => id.trim()).filter(Boolean)

const configuration = new Configuration({
    apiKey: process.env.OPENAI_API_KEY,
});

let sysprompt = ""

const client = new Client({
    intents:
        [IntentsBitField.Flags.Guilds,
        IntentsBitField.Flags.GuildMessages,
        IntentsBitField.Flags.MessageContent,
        IntentsBitField.Flags.GuildMessageReactions,
        IntentsBitField.Flags.GuildVoiceStates
        ]
});

client.on("ready", async (args) => {
    console.log("ready")
})

client.on("messageCreate", async (msg) => {
    // console.log("msg!", msg.content)
    if (msg.author.bot) return

    // X(Twitter) URL検出
    const xUrlRegex = /(https?:\/\/(?:x\.com|twitter\.com)\/[^\s]+)/gi;
    const urls = msg.content.match(xUrlRegex);

    if (urls && urls.length > 0) {
        for (const url of urls) {
            try {
                const res = await axios.get(url, {
                    headers: { "User-Agent": "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)" }
                });
                const html = res.data;
                // og:descriptionタグがあるか判定
                const ogTag = html.match(/property=["']og:description["']/i);
                if (!ogTag) {
                    // try vxtwitter first; if vxtwitter's OGP shows failure text, fallback to fxtwitter
                    console.log("ogTag not found, trying vxtwitter/fxtwitter")
                    const replacedMsg = await tryVxThenFx(url, msg.content)
                    msg.reply(replacedMsg);
                    return;
                }
            } catch (e) {
                // 取得失敗時もvxtwitterに置換（ただしvxtwitterが "Failed to scan your link" を返す場合は fxtwitter に置換）
                const replacedMsg = await tryVxThenFx(url, msg.content)
                msg.reply(replacedMsg);
                return;
            }
        }
    }

    if (!DISCORD_CHANNELS.includes(msg.channel.id)) return
    if (msg.content.startsWith("!") || msg.content.startsWith("！")) return
    
    if (msg.reference) {
        const replyChain = await getReplyChain(msg);
        const retult = await generateReplyWithRef([...replyChain, msg])
        msg.reply(retult)
        return
    }
    const result = await generateReply(msg.content)
    msg.reply(result);
});

client.login(process.env.DISCORD_TOKEN)

async function getReplyChain(message) {
    const replyChain = [];
    let currentMessage = message;

    while (currentMessage.reference) {
        try {
            const referencedMessage = await currentMessage.channel.messages.fetch(currentMessage.reference.messageId);
            replyChain.unshift(referencedMessage);
            currentMessage = referencedMessage;
        } catch (error) {
            console.error('Error fetching message:', error);
            break;
        }
    }

    return replyChain;
}


const openai = new OpenAIApi(configuration);

const getSysPrompt = () => {
    return sysprompt
}

const getPromptTask = async () => {
    // const { data } = await axios.get(SYS_API)
    sysprompt = ""
}

setInterval(getPromptTask, 1000 * 60 )
await getPromptTask()

const gpt3 = "gpt-3.5-turbo"
const gpt4 = "gpt-4"

const generateReply = async (userPrompt) => {
    const isGPT3 = userPrompt.includes("gpt3")

    const completion = await openai.createChatCompletion({
        model: isGPT3 ? gpt3 : gpt4,
        messages: [
            { "role": "system", "content": getSysPrompt() },
            { "role": "user", "content": userPrompt }
        ],
    });

    const reply = completion.data.choices[0].message.content;
    console.log(reply.slice(0, 10), completion.data.usage.total_tokens)
    return reply
}

const generateReplyWithRef = async (prompt) => {
    const msgs = [
        { "role": "system", "content": getSysPrompt() }
    ]
    if (prompt.length >= 6) {
        prompt = prompt.slice(-6)
    }

    prompt.forEach(p => {
        if (p.author.id === client?.user?.id) {
            msgs.push({
                "role": "assistant",
                "content": p.content
            })
        } else {
            msgs.push({
                "role": "user",
                "content": p.content
            })
        }
    })

    const isGPT3 = msgs.filter(m => m.role === "user").some(p => p.content.includes("gpt3"))

    const completion = await openai.createChatCompletion({
        model: isGPT3 ? gpt3 : gpt4,
        messages: msgs,
    });

    const reply = completion.data.choices[0].message.content;
    console.log(reply.slice(0, 10), completion.data.usage.total_tokens)
    return reply
}

async function safeFetchHtml(url) {
	try {
		const { data } = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)" } });
		return data;
	} catch (err) {
		return null;
	}
}

async function tryVxThenFx(originalUrl, originalMsgContent) {
	const vxtUrl = originalUrl.replace(/(?:x\.com|twitter\.com)/, "vxtwitter.com");
	const vxtHtml = await safeFetchHtml(vxtUrl);

    // いったん適当やけどまあ動くやろ
    const vxfailed = vxtHtml.includes("Failed to scan your link! This may be due to an incorrect link")

	if (vxfailed) {
        console.log("vxtwitter fetch failed or link scan failed, falling back to fxtwitter")
		const fxUrl = originalUrl.replace(/(?:x\.com|twitter\.com)/, "fxtwitter.com");
		return originalMsgContent.replace(originalUrl, fxUrl);
	}

	if (vxtHtml.toLowerCase().includes("failed to scan your link")) {
		const fxUrl = originalUrl.replace(/(?:x\.com|twitter\.com)/, "fxtwitter.com");
		return originalMsgContent.replace(originalUrl, fxUrl);
	}

	// otherwise use vxtwitter
    console.log("using vxtwitter")
	return originalMsgContent.replace(originalUrl, vxtUrl);
}

