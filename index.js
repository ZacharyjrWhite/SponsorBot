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
process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

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

        const header = rows[0];
        const dataRows = rows.slice(1);

        const colGuildId = header.indexOf("guild ID");
        const colCreator = header.indexOf("Creator");
        const colChannel = header.indexOf("Channel");
        const colSponsor = header.indexOf("Sponsor");
        const colDraftDeadline = header.indexOf("Draft Deadline - Disc. Date");
        const colUploadDeadline = header.indexOf("Upload Deadline - Disc. Date");
        const colMonth = header.indexOf("Month");
        const colYear = header.indexOf("Year");
        const colShouldNotify = header.indexOf("Should Notify");
        const colStatus = header.indexOf("status");
        const colStatusSend = header.indexOf("Status Send");
        const colStatusMessage = header.indexOf("Status Message");
        const colIgnore = header.indexOf("ignore");
        const colType = header.indexOf("Type");

        // Reset the global cache
        scheduleCache = {};

        for (const [index, row] of dataRows.entries()) {
            // Minimal validation
            if (!row[colGuildId] || !row[colChannel]) continue;

            const guildId = row[colGuildId].trim();
            const creator = row[colCreator] || "Unknown Creator";
            const channel = row[colChannel];
            const sponsor = row[colSponsor] || "N/A";
            const draftDeadline = row[colDraftDeadline] || "N/A";
            const uploadDeadline = row[colUploadDeadline] || "N/A";
            const month = row[colMonth] || "N/A";
            const year = row[colYear] || "N/A";
            const shouldNotify = row[colShouldNotify] || "1";

            const status = (row[colStatus] || "").trim();
            const statusSend = (row[colStatusSend] || "").trim();

            // Safely handle statusMessage
            let rawStatusMsg = row[colStatusMessage] || "";
            const statusMessage = typeof rawStatusMsg === "string" ? rawStatusMsg.trim() : "";

            const ignore = (row[colIgnore] || "").trim();
            const type = (row[colType] || "").trim();

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
                year,
                shouldNotify,
                status,
                statusSend,
                statusMessage,
                ignore,
                type,
                currentRowNumber
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
    return (r << 16) | (g << 8) | b;
}

function getStatusColor(STATUS) {
    switch (STATUS.toLowerCase()) {
        case "pending":
            return "e82020";
        case "draft":
            return "e8db20";
        case "complete":
            return "63e820";
        default:
            return "e8db20";
    }
}

/************************************************
 * 6) Embed Creation
 ************************************************/
/**
 * createEmbedsFromData(items):
 * Used by the CRON job to send reminders.
 * Only include rows where:
 *   - shouldNotify == "1"
 *   - ignore == "0"
 *   - statusSend == "1"
 */
function createEmbedsFromData(items) {
    const validItems = items.filter(
        (i) => i.shouldNotify === "1" && i.ignore === "0" && i.statusSend === "1"
    );

    return validItems.map((item) => {
        // Build the fields array dynamically
        const fields = [
            { name: "Status", value: item.status, inline: false },
        ];

        // Only add "Message" if statusMessage is non-empty
        if (item.statusMessage) {
            fields.push({ name: "Message", value: item.statusMessage, inline: false });
        }

        // Only add "Type" if it's non-empty
        if (item.type) {
            fields.push({ name: "Type", value: item.type, inline: false });
        }

        fields.push(
            { name: "Draft Deadline", value: item.draftDeadline.replace("R", "D"), inline: false },
            { name: " ", value: item.draftDeadline, inline: false },
            { name: "Upload Deadline", value: item.uploadDeadline.replace("R", "D"), inline: false },
            { name: " ", value: item.uploadDeadline, inline: false },
        );

        return new EmbedBuilder()
            .setColor(getStatusColor(item.status))
            .setTitle(`Sponsor: ${item.sponsor}`)
            .addFields(fields);
    });
}

/**
 * createEmbedsIgnoreNotify(items):
 * Used by /schedule.
 * Shows all rows (regardless of shouldNotify/status) as long as ignore == "0".
 */
function createEmbedsIgnoreNotify(items) {
    const validItems = items.filter((i) => i.ignore === "0");
    if (!validItems.length) return [];

    return validItems.map((item) => {
        // Build the fields array dynamically
        const fields = [
            { name: "Status", value: item.status, inline: false },
        ];

        // Only add "Message" if statusMessage is non-empty
        if (item.statusMessage) {
            fields.push({ name: "Message", value: item.statusMessage, inline: false });
        }

        // Only add "Type" if it's non-empty
        if (item.type) {
            fields.push({ name: "Type", value: item.type, inline: false });
        }

        fields.push(
            { name: "Draft Deadline", value: item.draftDeadline.replace("R", "D"), inline: false },
            { name: " ", value: item.draftDeadline, inline: false },
            { name: "Upload Deadline", value: item.uploadDeadline.replace("R", "D"), inline: false },
            { name: " ", value: item.uploadDeadline, inline: false }
        );

        return new EmbedBuilder()
            .setColor(getStatusColor(item.status))
            .setTitle(`Sponsor: ${item.sponsor}`)
            .addFields(fields);
    });
}

/**
 * createScheduleEmbeds(guildId, monthFilter = "All", yearFilter = "All"):
 *   - Filters out any items that are ignored.
 *   - If monthFilter != 'All', item.month must match.
 *   - If yearFilter != 'All', item.year must match.
 */
function createScheduleEmbeds(guildId, monthFilter = "All", yearFilter = "All") {
    const guildData = scheduleCache[guildId] || [];
    if (!guildData.length) {
        return [];
    }

    // Convert user input to lowercase for comparisons
    const monthLower = monthFilter.toLowerCase();
    const yearLower = yearFilter.toLowerCase();

    // Filter by month/year only if not "all"
    const filteredData = guildData.filter((item) => {
        if (item.ignore === "1") return false;

        const monthMatches =
            monthLower === "all" || item.month.toLowerCase() === monthLower;

        const yearMatches =
            yearLower === "all" || item.year.toLowerCase() === yearLower;

        return monthMatches && yearMatches;
    });

    return createEmbedsIgnoreNotify(filteredData);
}

/************************************************
 * 7) Slash Command Registration
 ************************************************/
const commands = [
    new SlashCommandBuilder()
        .setName("schedule")
        .setDescription("Display the current schedule for this server.")
        .addStringOption((option) =>
            option
                .setName("month")
                .setDescription('Month name (e.g. "January") or "All"')
                .setRequired(false)
        )
        .addStringOption((option) =>
            option
                .setName("year")
                .setDescription('Year (e.g. "2023") or "All"')
                .setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName("refresh")
        .setDescription("Refresh the schedule data from Google Sheets."),
    new SlashCommandBuilder()
        .setName("resend")
        .setDescription("Force a resend of notifications, in case changes have been made."),
].map((cmd) => cmd.toJSON());

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
client.once("ready", async () => {
    console.log(`Logged in as ${client.user.tag}.`);

    client.user.setPresence({
        status: "online",
        activities: [
            {
                name: "ELITE REPRESENTATION FOR ELITE GAMERS",
                type: ActivityType.Playing,
            },
        ],
    });

    await registerCommands(client.user.id);
    await fetchScheduleData();
    // Optionally start reminders immediately:
    // sendScheduledReminders();

    // CRON to refresh data and then send reminders
    console.log("Scheduling cron timer:", process.env.CRONTIMER);
    cron.schedule(process.env.CRONTIMER, async () => {
        console.log("Cron job: refreshing schedule data...");
        await fetchScheduleData();
        sendScheduledReminders();
    });

    // Optional: separate cron just to refresh cache
    console.log("Scheduling cron cache refresh timer:", process.env.REFRESHTIMER);
    cron.schedule(process.env.REFRESHTIMER, async () => {
        console.log("Cron job: refreshing schedule cache...");
        await fetchScheduleData();
    });
    
    // Runs every 5 minutes
    cron.schedule('*/5 * * * *', () => {
      console.log('Re-loading environment variables...');
      require('dotenv').config();
    });

    // Clear console on the same timer
    console.log("Clearing Console:", process.env.REFRESHTIMER);
    cron.schedule(process.env.REFRESHTIMER, async () => {
        console.clear();
    });
});

/************************************************
 * 9) sendScheduledReminders()
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

            // Group items by channel
            const dataByChannel = {};
            for (const item of guildData) {
                const chanKey = item.channel;
                if (!dataByChannel[chanKey]) {
                    dataByChannel[chanKey] = [];
                }
                dataByChannel[chanKey].push(item);
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
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const member = interaction.member;
    const isAdmin = member.permissions.has(PermissionsBitField.Flags.Administrator);
    const isMod = member.roles.cache.some(
        (role) => role.name.toLowerCase() === process.env.ROLE
    );

    // Handle /schedule
    if (interaction.commandName === "schedule") {
        if (!isAdmin && !isMod) {
            return interaction.reply({
                content: "You do not have permission to use this command!",
                ephemeral: true,
            });
        }

        // #1 Identify the guild data
        const guildId = interaction.guildId;
        const guildData = scheduleCache[guildId] || [];

        // #2 Build a list of valid channels from the spreadsheet
        const validChannels = guildData
            .map((item) => String(item.channel).trim().toLowerCase())
            .filter(Boolean);

        // #3 Check if the user is in a valid channel
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
            // #4 Parse any user-provided filters
            const monthArg = interaction.options.getString("month") || "All";
            const yearArg = interaction.options.getString("year") || "All";

            // #5 Filter the data using createScheduleEmbeds
            //    (which shows rows ignoring shouldNotify, etc.)
            const embeds = createScheduleEmbeds(guildId, monthArg, yearArg);

            // #6 If there's nothing after filtering, inform the user
            if (!embeds.length) {
                await interaction.reply({
                    content: `No schedule data found for month "${monthArg}" and year "${yearArg}".`,
                    ephemeral: true,
                });
                return;
            }

            // #7 Otherwise, show the result
            await interaction.reply({
                content: `Showing schedule for Month: **${monthArg}**, Year: **${yearArg}**`,
                embeds: embeds,
                ephemeral: true,
            });
        } catch (err) {
            console.error("Error handling /schedule command:", err);
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(
                    "An error occurred while processing your request."
                );
            } else {
                await interaction.reply("An error occurred while processing your request.");
            }
        }
    }

    // Handle /refresh
    if (interaction.commandName === "refresh") {
        if (!isAdmin && !isMod) {
            return interaction.reply({
                content: "You do not have permission to use this command!",
                ephemeral: true,
            });
        }

        try {
            await fetchScheduleData();
            await interaction.reply({
                content: "Schedule data has been refreshed from Google Sheets.",
                ephemeral: true,
            });
        } catch (err) {
            console.error("Error handling /refresh command:", err);
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(
                    "An error occurred while refreshing the schedule data."
                );
            } else {
                await interaction.reply("An error occurred while refreshing the schedule data.");
            }
        }
    }

    // Handle /resend
    if (interaction.commandName === "resend") {
        if (!isAdmin && !isMod) {
            return interaction.reply({
                content: "You do not have permission to use this command!",
                ephemeral: true,
            });
        }

        try {
            await fetchScheduleData();
            sendScheduledReminders();
            await interaction.reply({
                content: "Schedule data has been re-fetched and reminders have been resent.",
                ephemeral: true,
            });
        } catch (err) {
            console.error("Error handling /resend command:", err);
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(
                    "An error occurred while resending the schedule data."
                );
            } else {
                await interaction.reply("An error occurred while resending the schedule data.");
            }
        }
    }
});

/************************************************
 * 11) Login
 ************************************************/
client.login(process.env.DISCORD_TOKEN).catch((err) => {
    console.error("Failed to login to Discord:", err);
});
