require("dotenv").config(); // Loads environment variables from a .env file into process.env
const {
    Client,
    GatewayIntentBits,
    PermissionsBitField,
    Partials,
    REST,
    Routes,
    SlashCommandBuilder,
    EmbedBuilder,
    ActivityType
} = require("discord.js");
const { google } = require("googleapis");
const cron = require("node-cron");

/************************************************
 * 1) Global Error Handling
 ************************************************/
// These handlers help catch common errors and print them to the console,
// preventing the Node process from crashing unexpectedly.

// Catch all unhandled promise rejections (async code that rejects without .catch)
process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

// Catch all uncaught exceptions (errors thrown in sync code not wrapped in try/catch)
process.on("uncaughtException", (err) => {
    console.error("Uncaught Exception thrown:", err);
});

/************************************************
 * 2) Initialize Discord Client
 ************************************************/
// Create a new Discord client instance with specific intents and partials.
// - GatewayIntentBits.Guilds, GuildMessages: required to see and send messages in guilds
// - Partials.Channel: allows partial channel objects for certain events
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
    partials: [Partials.Channel],
});

// We'll store the schedule data from Google Sheets in this object,
// keyed by Guild ID for easy lookup.
let scheduleCache = {};

/************************************************
 * 3) Google Sheets Setup
 ************************************************/
// These environment variables hold the service account credentials for Google Sheets.
const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
let serviceAccountPrivateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;

// Convert escaped \n characters in the private key to actual newlines.
serviceAccountPrivateKey = serviceAccountPrivateKey.replace(/\\n/g, "\n");

/**
 * Returns a Google-auth JWT client using the service account credentials
 * for read-only access to the Sheets API.
 */
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
/**
 * Fetches schedule data from a specified range in a Google Sheet.
 * - Reads environment variables for sheet ID, range, etc.
 * - Populates the global scheduleCache object with relevant data, keyed by guildId.
 */
async function fetchScheduleData() {
    try {
        // Obtain authenticated Sheets client
        const auth = await getAuth();
        const sheets = google.sheets({ version: "v4", auth });

        // Make a request to read the specified range from the sheet.
        const result = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.SHEET_ID,
            range: `${process.env.SHEETNAME}!${process.env.STARTING_COLUMN}:${process.env.ENDING_COLUMN}`,
        });

        const rows = result.data.values;

        // If no rows were returned, log a message and exit.
        if (!rows || rows.length === 0) {
            console.log("No schedule data found in the Sheet.");
            return;
        }

        // The first row is assumed to be headers (column names).
        const header = rows[0];
        // All subsequent rows are the actual data.
        const dataRows = rows.slice(1);

        // Identify each column index by name in the header row.
        const colGuildId = header.indexOf("guild ID");
        const colCreator = header.indexOf("Creator");
        const colChannel = header.indexOf("Channel");
        const colSponsor = header.indexOf("Sponsor");
        const colDraftDeadline = header.indexOf("Draft Deadline - Disc. Date");
        const colUploadDeadline = header.indexOf("Upload Deadline - Disc. Date");
        const colMonth = header.indexOf("Month");
        const colShouldNotify = header.indexOf("Should Notify");
        const colStatus = header.indexOf("status");

        // Reset the global cache before re-populating (to avoid stale data).
        scheduleCache = {};

        // Loop through each row of data to build our schedule cache.
        for (const [index, row] of dataRows.entries()) {
            // Some rows might be incomplete or empty; skip them if key info is missing.
            if (!row[colGuildId] || !row[colChannel]) continue;

            // Extract each cell from the row by its column index.
            const guildId = row[colGuildId].trim();
            const creator = row[colCreator] || "Unknown Creator";
            const channel = row[colChannel];
            const sponsor = row[colSponsor] || "N/A";
            const draftDeadline = row[colDraftDeadline] || "N/A";
            const uploadDeadline = row[colUploadDeadline] || "N/A";
            const month = row[colMonth] || "N/A";
            const shouldNotify = row[colShouldNotify] || "1";
            const status = row[colStatus].trim();

            // currentRowNumber is optional debug info to identify which row in the sheet this is.
            const currentRowNumber = index;

            // Initialize the array for this guild if it doesn't exist in our cache.
            if (!scheduleCache[guildId]) {
                scheduleCache[guildId] = [];
            }

            // Push an object representing a single row into our cache array for this guild.
            scheduleCache[guildId].push({
                creator,
                channel,
                sponsor,
                draftDeadline,
                uploadDeadline,
                month,
                shouldNotify,
                status,
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
/**
 * Generates a random color (integer) for use in Discord embeds.
 * - It picks one of the RGB channels to be dominant (maxVal=194) and randomizes the others.
 * - Returns the color as a single integer (0xRRGGBB).
 */
function getRandomColor() {
    const dominant = Math.floor(Math.random() * 3);
    const maxVal = 194;
    const randomValue = () => Math.floor(Math.random() * (maxVal + 1));

    let r, g, b;
    // Based on which channel is dominant, assign maxVal to that channel.
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

    // Convert the three separate R/G/B values into a single integer (Discord expects a hex integer).
    return (r << 16) | (g << 8) | b;
}

/************************************************
 * 6) Embed Creation
 ************************************************/
/**
 * 6A) createEmbedsFromData(items):
 *    Used by the CRON job reminders, which only want rows that:
 *    1) have shouldNotify !== '0'
 *    2) have status = 'Pending' (case-insensitive)
 *
 *    Returns an array of EmbedBuilder objects to be sent in a Discord message.
 */
function createEmbedsFromData(items) {
    // Filter the items so we only include relevant rows.
    const validItems = items.filter(
        (i) =>
            i.shouldNotify !== "0" &&
            i.status.toLowerCase() === "pending"
    );

    // For each valid item, build a Discord embed.
    return validItems.map((item) => {
        return new EmbedBuilder()
            .setColor(getRandomColor())
            .setTitle(`Sponsor: ${item.sponsor}`)
            .addFields(
                { name: "Status", value: item.status, inline: false },
                { name: "Draft Deadline", value: item.draftDeadline, inline: false },
                { name: "Upload Deadline", value: item.uploadDeadline, inline: false }
            );
    });
}

/**
 * 6B) createEmbedsIgnoreNotify(items):
 *     Used by the /schedule slash command.
 *     This ignores shouldNotify and status checks, showing all rows in the result set.
 */
function createEmbedsIgnoreNotify(items) {
    // If there's no data, return an empty array (no embeds).
    if (!items.length) return [];

    // Build embeds for all items without filtering.
    return items.map((item) => {
        return new EmbedBuilder()
            .setColor(getRandomColor())
            .setTitle(`Sponsor: ${item.sponsor}`)
            .addFields(
                { name: "Status", value: item.status, inline: false },
                { name: "Draft Deadline", value: item.draftDeadline, inline: false },
                { name: "Upload Deadline", value: item.uploadDeadline, inline: false }
            );
    });
}

/**
 * 6C) Helper for the slash command: createScheduleEmbeds
 *     Filters the data by the specified month, then calls createEmbedsIgnoreNotify
 *     to build the embed objects.
 */
function createScheduleEmbeds(guildId, monthFilter = "All") {
    // Get all schedule data for this guild.
    const guildData = scheduleCache[guildId] || [];
    if (!guildData.length) {
        return [];
    }

    // Convert the user input (month) to lowercase for comparison.
    const normalizedFilter = monthFilter.toLowerCase();

    // Filter the guild data by the month, unless "All" is specified.
    const filteredData = guildData.filter((item) => {
        if (normalizedFilter === "all") return true;
        return item.month.toLowerCase() === normalizedFilter;
    });

    // Return a list of embeds for the filtered data (ignoring shouldNotify).
    return createEmbedsIgnoreNotify(filteredData);
}

/************************************************
 * 7) Slash Command Registration
 ************************************************/
// Define the slash command(s) this bot offers. In this case: /schedule
const commands = [
    new SlashCommandBuilder()
        .setName("schedule")
        .setDescription("Display the current schedule for this server.")
        .addStringOption((option) =>
            option
                .setName("month")
                .setDescription('Month name (e.g. "January") or "All"')
                .setRequired(false)
        ),
].map((cmd) => cmd.toJSON());

/**
 * Registers the slash commands globally using the Discord REST API.
 * - If you want per-guild commands, you can use Routes.applicationGuildCommands(clientId, guildId).
 */
async function registerCommands(clientId, guildId = null) {
    try {
        const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
        await rest.put(Routes.applicationCommands(clientId), { body: commands });
        console.log(`Slash commands registered (global).`);
    } catch (err) {
        console.error("Error registering slash commands:", err);
    }
}

/************************************************
 * 8) Bot Events & Startup
 ************************************************/
// Once the bot is ready (logged in successfully), we register commands and fetch data.
client.once("ready", async () => {
    console.log(`Logged in as ${client.user.tag}.`);
    
    client.user.setPresence({
        status: "online", // 'idle', 'dnd', or 'invisible' also possible
        activities: [{
        name: "ELITE REPRESENTATION FOR ELITE GAMERS",
        type: ActivityType.Playing,
        }],
    });
    
    await registerCommands(client.user.id);

    // Fetch data initially from Google Sheets to populate scheduleCache.
    await fetchScheduleData();

    // Schedule a cron job to refresh data every 2 hours (0 */2 * * *).
    // Adjust the schedule as needed.
    console.log("Scheduling cron timer: " , process.env.CRONTIMER)
    cron.schedule(process.env.CRONTIMER, async () => {
        console.log("Cron job: refreshing schedule data...");
        await fetchScheduleData();
        sendScheduledReminders();
    });

    console.log("Scheduling cron cache refresh timer: " , process.env.REFRESHTIMER)
    cron.schedule(process.env.REFRESHTIMER, async () => {
        console.log("Cron job: refreshing schedule cache...");
        await fetchScheduleData();
    });
});

/************************************************
 * 9) sendScheduledReminders()
 *    CRON-based function to send out the schedule reminders.
 ************************************************/
/**
 * Iterates through each guild's data in scheduleCache and sends reminder messages
 * to the corresponding channels if shouldNotify !== "0" and status is "Pending".
 */
async function sendScheduledReminders() {
    try {
        // Get a list of all guild IDs we've cached.
        const guildIds = Object.keys(scheduleCache);

        // Loop through each guild in the cache.
        for (const guildId of guildIds) {
            const guildData = scheduleCache[guildId];
            if (!guildData || !guildData.length) continue; // Skip if empty or no data.

            // Attempt to find the actual Guild object in Discord.js cache.
            const guild = client.guilds.cache.get(guildId);
            if (!guild) {
                console.log(`Bot not in guild ${guildId} or not cached.`);
                continue;
            }

            // Group rows by their "channel" field to send them together.
            const dataByChannel = {};
            for (const item of guildData) {
                if (!dataByChannel[item.channel]) {
                    dataByChannel[item.channel] = [];
                }
                dataByChannel[item.channel].push(item);
            }

            // For each channel in this guild, gather valid items and send them.
            for (const [channelNameOrId, items] of Object.entries(dataByChannel)) {
                // Attempt to find the channel by either its name or its ID.
                const targetChannel = guild.channels.cache.find(
                    (ch) => ch.name === channelNameOrId || ch.id === channelNameOrId
                );
                if (!targetChannel) {
                    console.log(
                        `Channel "${channelNameOrId}" not found in guild ${guildId}`
                    );
                    continue;
                }

                // Build a list of embeds for items that should be notified and are pending.
                const embedList = createEmbedsFromData(items);
                if (!embedList.length) continue; // If no valid items, skip sending.

                // Send the embeds in a single message to the channel.
                await targetChannel.send({
                    content: `Here is the schedule:`,
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
// This event triggers whenever a user invokes a slash command the bot handles.
client.on("interactionCreate", async (interaction) => {
    // If it's not a slash command, ignore.
    if (!interaction.isChatInputCommand()) return;

    // Check if the command is /schedule.
    if (interaction.commandName === "schedule") {
        const member = interaction.member;
        const guildId = interaction.guildId;

        // Only let admins or members with the "SponsorBot" role (case-insensitive) use this command.
        const isAdmin = member.permissions.has(PermissionsBitField.Flags.Administrator);
        const isMod = member.roles.cache.some(
            (role) => role.name.toLowerCase() === process.env.ROLE
        );

        // If not allowed, reply with an ephemeral (invisible) error message.
        if (!isAdmin && !isMod) {
            return interaction.reply({
                content: "You do not have permission to use this command!",
                ephemeral: true,
            });
        }

        // The code below ensures the command can only be run in channels
        // that are in the scheduleCache for this guild.
        const guildData = scheduleCache[guildId] || [];
        const validChannels = guildData
            .map((item) => String(item.channel).trim().toLowerCase())
            .filter(Boolean);

        const currentChannelName = interaction.channel?.name?.toLowerCase() || "";
        const currentChannelId = interaction.channel?.id;

        const isChannelAllowed =
            validChannels.includes(currentChannelName) ||
            validChannels.includes(currentChannelId);

        if (!isChannelAllowed) {
            return interaction.reply({
                content: "You can only run this command in a valid schedule channel!",
                ephemeral: true,
            });
        }

        try {
            // Parse the optional "month" argument (default = "All").
            const monthArg = interaction.options.getString("month") || "All";

            // Build embeds for the specified month.
            const embeds = createScheduleEmbeds(guildId, monthArg);

            // If no data is found for that month, let the user know.
            if (!embeds.length) {
                await interaction.reply({
                    content: `No schedule data found for month "${monthArg}".`,
                    ephemeral: false,
                });
                return;
            }

            // Otherwise, show the schedule for that month in the current channel.
            await interaction.reply({
                content: `Showing schedule for month: **${monthArg}**`,
                embeds: embeds,
                ephemeral: false,
            });
        } catch (err) {
            console.error("Error handling slash command:", err);
            // If we already replied or deferred, follow up. Otherwise, new reply.
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
    }
});

/************************************************
 * 11) Login & Done
 ************************************************/
// Finally, log in to Discord with the bot's token.
// If it fails, we'll see the error in the console.
client.login(process.env.DISCORD_TOKEN).catch((err) => {
    console.error("Failed to login to Discord:", err);
});
