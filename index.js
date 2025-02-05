require("dotenv").config();
const {
    Client,
    GatewayIntentBits,
    Partials,
    REST,
    Routes,
    SlashCommandBuilder,
    EmbedBuilder,
} = require("discord.js");
const { google } = require("googleapis");
const cron = require("node-cron");

/************************************************
 * 1) Global Error Handling
 ************************************************/
// Catch all unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

// Catch all uncaught exceptions
process.on("uncaughtException", (err) => {
    console.error("Uncaught Exception thrown:", err);
});

/************************************************
 * 2) Initialize Discord Client
 ************************************************/
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
    partials: [Partials.Channel],
});

let scheduleCache = {};

/************************************************
 * 3) Google Sheets Setup
 ************************************************/
const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
let serviceAccountPrivateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;

serviceAccountPrivateKey = serviceAccountPrivateKey.replace(/\\n/g, "\n");

async function getAuth() {
    const auth = new google.auth.JWT({
        email: serviceAccountEmail,
        key: serviceAccountPrivateKey,
        scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });
    return auth;
}

/************************************************
 * 4) Fetch Data from Google Sheets
 ************************************************/
async function fetchScheduleData() {
    try {
        const auth = await getAuth();
        const sheets = google.sheets({ version: "v4", auth });

        const result = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.SHEET_ID,
            range: `${process.env.SHEETNAME}!${process.env.STARTING_COLUMN}:${process.env.ENDING_COLUMN}`,
        });

        const rows = result.data.values;

        if (!rows || rows.length === 0) {
            console.log("No schedule data found in the Sheet.");
            return;
        }

        // The first row is assumed to be headers.
        const header = rows[0];
        const dataRows = rows.slice(1);

        // Identify column indexes
        const colGuildId = header.indexOf("guild ID");
        const colCreator = header.indexOf("Creator");
        const colChannel = header.indexOf("Channel");
        const colSponsor = header.indexOf("Sponsor");
        const colDraftDeadline = header.indexOf("Draft Deadline - Disc. Date");
        const colUploadDeadline = header.indexOf("Upload Deadline - Disc. Date");
        const colMonth = header.indexOf("Month");
        const colShouldNotify = header.indexOf("Should Notify");

        // Reset cache
        scheduleCache = {};

        // Build schedule cache
        for (const [index, row] of dataRows.entries()) {
            // Skip empty lines or incomplete lines
            if (!row[colGuildId] || !row[colChannel]) continue;

            const guildId = row[colGuildId].trim();
            const creator = row[colCreator] || "Unknown Creator";
            const channel = row[colChannel];
            const sponsor = row[colSponsor] || "N/A";
            const draftDeadline = row[colDraftDeadline] || "N/A";
            const uploadDeadline = row[colUploadDeadline] || "N/A";
            const month = row[colMonth] || "N/A";
            const shouldNotify = row[colShouldNotify] || "1";
            const currentRowNumber = index;

            if (!scheduleCache[guildId]) {
                scheduleCache[guildId] = [];
            }

            scheduleCache[guildId].push({
                creator,
                channel,
                sponsor,
                draftDeadline,
                uploadDeadline,
                month,
                shouldNotify,
                currentRowNumber,
            });
        }

        console.log("Schedule cache refreshed from Google Sheets!");
    } catch (err) {
        console.error("Error fetching schedule data:", err);
    }
}

/************************************************
 * 5) Random Color Helper for Embeds
 ************************************************/
function getRandomColor() {
    const dominant = Math.floor(Math.random() * 3);
    const maxVal = 194;
    const randomValue = () => Math.floor(Math.random() * (maxVal + 1));

    let r, g, b;
    if (dominant === 0) {
        r = maxVal;
        g = randomValue();
        b = randomValue();
    } else if (dominant === 1) {
        r = randomValue();
        g = maxVal;
        b = randomValue();
    } else {
        r = randomValue();
        g = randomValue();
        b = maxVal;
    }

    // Convert to a single integer color (Discord expects a hex integer)
    return (r << 16) | (g << 8) | b;
}


/************************************************
 * 6) Embed Creation
 ************************************************/
// 6A) createEmbedsFromData(items):
// Used by the CRON job. Shows ONLY records with shouldNotify !== '0'.
function createEmbedsFromData(items) {
    const validItems = items.filter((i) => i.shouldNotify !== "0");
    if (!validItems.length) return [];

    return validItems.map((item) => {
        return new EmbedBuilder()
            .setColor(getRandomColor())
            .setTitle(`Sponsor: ${item.sponsor}`)
            .addFields(
                { name: "Draft Deadline", value: item.draftDeadline, inline: false },
                { name: "Upload Deadline", value: item.uploadDeadline, inline: false }
            );
    });
}

// 6B) createEmbedsIgnoreNotify(items):
// Used by the SLASH COMMAND. Shows ALL records, ignoring shouldNotify.
function createEmbedsIgnoreNotify(items) {
    if (!items.length) return [];

    return items.map((item) => {
        return new EmbedBuilder()
            .setColor(getRandomColor())
            .setTitle(`Sponsor: ${item.sponsor}`)
            .addFields(
                { name: "Draft Deadline", value: item.draftDeadline, inline: false },
                { name: "Upload Deadline", value: item.uploadDeadline, inline: false }
            );
    });
}

// 6C) Helper for the slash command: createScheduleEmbeds
function createScheduleEmbeds(guildId, monthFilter = "All") {
    const guildData = scheduleCache[guildId] || [];
    if (!guildData.length) {
        return [];
    }

    const normalizedFilter = monthFilter.toLowerCase();

    const filteredData = guildData.filter((item) => {
        if (normalizedFilter === "all") return true;
        return item.month.toLowerCase() === normalizedFilter;
    });

    return createEmbedsIgnoreNotify(filteredData);
}

/************************************************
 * 7) Slash Command Registration
 ************************************************/
const commands = [
    new SlashCommandBuilder()
        .setName("schedule")
        .setDescription(
            "Display the current schedule for this server (ignoring shouldNotify)."
        )
        .addStringOption((option) =>
            option
                .setName("month")
                .setDescription('Month name (e.g. "January") or "All"')
                .setRequired(false)
        ),
].map((cmd) => cmd.toJSON());

async function registerCommands(clientId, guildId = null) {
    try {
        const rest = new REST({ version: "10" }).setToken(
            process.env.DISCORD_TOKEN
        );
        await rest.put(Routes.applicationCommands(clientId), { body: commands });
        console.log(`Slash commands registered (global).`);
    } catch (err) {
        console.error("Error registering slash commands:", err);
    }
}

/************************************************
 * 8) Bot Events & Startup
 ************************************************/
client.once("ready", async () => {
    console.log(`Logged in as ${client.user.tag}.`);
    await registerCommands(client.user.id);

    // Fetch data initially
    await fetchScheduleData();

    //  Cron job: once every hour
    cron.schedule("0 * * * *", async () => {
        console.log("Cron job: refreshing schedule data...");
        await fetchScheduleData();
        sendScheduledReminders();
    });
});

/************************************************
 * 9) sendScheduledReminders()
 *    CRON-based (shouldNotify !== '0' only)
 ************************************************/
async function sendScheduledReminders() {
    try {
        const guildIds = Object.keys(scheduleCache);
        for (const guildId of guildIds) {
            const guildData = scheduleCache[guildId];
            if (!guildData || !guildData.length) continue;

            const guild = client.guilds.cache.get(guildId);
            if (!guild) {
                console.log(`Bot not in guild ${guildId} or not cached.`);
                continue;
            }

            // Group data by channel
            const dataByChannel = {};
            for (const item of guildData) {
                if (!dataByChannel[item.channel]) {
                    dataByChannel[item.channel] = [];
                }
                dataByChannel[item.channel].push(item);
            }

            for (const [channelNameOrId, items] of Object.entries(dataByChannel)) {
                const targetChannel = guild.channels.cache.find(
                    (ch) => ch.name === channelNameOrId || ch.id === channelNameOrId
                );
                if (!targetChannel) {
                    console.log(
                        `Channel "${channelNameOrId}" not found in guild ${guildId}`
                    );
                    continue;
                }

                const embedList = createEmbedsFromData(items);
                if (!embedList.length) continue;

                await targetChannel.send({
                    content: `Here is the schedule (shouldNotify != '0') for **all** months:`,
                    embeds: embedList,
                });
            }
        }
    } catch (err) {
        console.error("Error in sendScheduledReminders:", err);
    }
}

/************************************************
 * 10) Interaction Create: slash command
 ************************************************/
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    try {
        if (interaction.commandName === "schedule") {
            const monthArg = interaction.options.getString("month") || "All";
            const embeds = createScheduleEmbeds(interaction.guildId, monthArg);

            if (!embeds.length) {
                await interaction.reply({
                    content: `No schedule data found for month "${monthArg}".`,
                    ephemeral: false,
                });
                return;
            }

            await interaction.reply({
                content: `Showing schedule for month: **${monthArg}**`,
                embeds: embeds,
                ephemeral: false,
            });
        }
    } catch (err) {
        console.error("Error handling slash command:", err);
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp(
                "An error occurred while processing your request."
            );
        } else {
            await interaction.reply(
                "An error occurred while processing your request."
            );
        }
    }
});

/************************************************
 * 11) Login & Done
 ************************************************/
client.login(process.env.DISCORD_TOKEN).catch((err) => {
    console.error("Failed to login to Discord:", err);
});
