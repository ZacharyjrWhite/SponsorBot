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
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

/************************************************
 * 1) Global Error Handling
 ************************************************/
/**
 * Ensures the bot logs and continues instead of crashing
 * on unhandled promise rejections or uncaught exceptions.
 */
process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (err) => {
    console.error("Uncaught Exception thrown:", err);
});

/************************************************
 * 2) Initialize Discord Client
 ************************************************/
/**
 * Creates a new Discord.js client instance with minimal required intents:
 * - Guilds, GuildMessages: to see and send messages in guilds.
 * We also define partials for channels in case we need partial data.
 */
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
    partials: [Partials.Channel],
});

/**
 * scheduleCache will hold the data loaded from Google Sheets,
 * keyed by each Guild's ID for easy reference.
 */
let scheduleCache = {};

/************************************************
 * 3) Google Sheets Setup
 ************************************************/
/**
 * Environment variables for your Google service account:
 * (email & private key). The private key may contain literal '\n'
 * which we replace with real newlines for proper usage.
 */
const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
let serviceAccountPrivateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
serviceAccountPrivateKey = serviceAccountPrivateKey.replace(/\\n/g, "\n");

/**
 * Creates a Google Auth JWT client using the service account
 * credentials, granting read-only scope to Google Sheets.
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
 * Pulls data from the specified Sheet and updates `scheduleCache`.
 * Each row is mapped to an object with relevant columns (guild ID, channel, status, etc.).
 */
async function fetchScheduleData() {
    try {
        // Get a Google Sheets authenticated client
        const auth = await getAuth();
        const sheets = google.sheets({ version: "v4", auth });

        // Make a request to read the specified range from your spreadsheet
        const result = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.SHEET_ID,
            range: `${process.env.SHEETNAME}!${process.env.STARTING_COLUMN}:${process.env.ENDING_COLUMN}`,
        });

        const rows = result.data.values;
        if (!rows || rows.length === 0) {
            console.log("No schedule data found in the Sheet.");
            return;
        }

        // The first row is headers; subsequent rows are data
        const header = rows[0];
        const dataRows = rows.slice(1);

        // Identify each needed column index
        const colGuildId = header.indexOf("guild ID");
        const colCreator = header.indexOf("Creator");
        const colChannel = header.indexOf("Channel");
        const colSponsor = header.indexOf("Brand");
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
        const colReminderDate = header.indexOf("Reminder Date");
        const colReminderDate2 = header.indexOf("Reminder Date 2");
        const colReminderType = header.indexOf("Reminder Type");

        let serverCount = client.guilds.cache.size;
        console.log(`Bot is currently in ${serverCount} servers`);

        // Reset or clear the old data
        scheduleCache = {};

        // Loop through each row of data from the Sheet
        for (const [index, row] of dataRows.entries()) {
            // Skip rows missing crucial info
            if (!row[colGuildId] || !row[colChannel]) continue;

            // Extract fields or default them
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

            // Handle status message field carefully
            let rawStatusMsg = row[colStatusMessage] || "";
            const statusMessage = typeof rawStatusMsg === "string" ? rawStatusMsg.trim() : "";

            const ignore = (row[colIgnore] || "").trim();
            const type = (row[colType] || "").trim();

            const reminderDate = (row[colReminderDate] || "").trim();
            const reminderDate2 = (row[colReminderDate2] || "").trim();
            // If no reminder type set, defaults to "private message"
            const reminderType = (row[colReminderType] || "private message").trim();

            const currentRowNumber = index;

            // Initialize an array in the cache for this guild if needed
            if (!scheduleCache[guildId]) {
                scheduleCache[guildId] = [];
            }

            // Push a data object to that guild's list
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
                currentRowNumber,
                reminderDate,
                reminderDate2,
                reminderType
            });
        }

        console.log("Schedule cache refreshed from Google Sheets!");
    } catch (err) {
        console.error("Error fetching schedule data:", err);
    }
}

/************************************************
 * 5) Color Helper for Embeds
 ************************************************/
/**
 * Converts a textual status (pending/draft/complete) into a hex color code
 * used by Discord.js embeds.
 */
function getStatusColor(STATUS) {
    switch ((STATUS || "").toLowerCase()) {
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
 * 5B) getCurrentDateFormatted
 ************************************************/
/**
 * Returns today's date as M/D/YYYY, e.g. 4/10/2025
 * Used to compare with reminderDate or reminderDate2 fields
 */
function getCurrentDateFormatted() {
    const now = new Date();
    const month = now.getMonth() + 1; // zero-based
    const day = now.getDate();
    const year = now.getFullYear();
    return `${month}/${day}/${year}`;
}

/************************************************
 * 6) Building Single Embed for an Item
 ************************************************/
/**
 * Given a single row item, builds an EmbedBuilder with sponsor, deadlines, etc.
 */
function buildEmbedForItem(item) {
    const fields = [{ name: "Status", value: item.status, inline: false }];

    // Adds "Message" if present
    if (item.statusMessage) {
        fields.push({ name: "Message", value: item.statusMessage, inline: false });
    }
    // Adds "Type" if present
    if (item.type) {
        fields.push({ name: "Type", value: item.type, inline: false });
    }

    // Add draft/upload deadlines
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
}

/************************************************
 * 6B) Filter Items that need a reminder Today
 ************************************************/
/**
 * Filters down to only the items that meet the reminder criteria:
 * shouldNotify=1, ignore=0, statusSend=1,
 * AND either reminderDate or reminderDate2 equals today's date
 */

let didMonthlyOverride = false;

function filterReminderItems(guildData) {
    const today = getCurrentDateFormatted();
    const currentDay = new Date().getDate();

    // If it's the 1st, OR it's the 2nd and we haven't done the monthly override yet
    if (!didMonthlyOverride && (currentDay === 1 || currentDay === 2)) {
        // Mark that we've used our monthly override so it doesn't repeat
        didMonthlyOverride = true;

        // Return "all" the items that normally would get reminders
        return guildData.filter(
            item =>
                item.shouldNotify === "1" &&
                item.ignore === "0" &&
                item.statusSend === "1"
        );
    }

    // Otherwise, keep the existing date match logic
    return guildData.filter(
        item =>
            item.shouldNotify === "1" &&
            item.ignore === "0" &&
            item.statusSend === "1" &&
            (item.reminderDate === today || item.reminderDate2 === today)
    );
}


/************************************************
 * 6C) createScheduleEmbeds - for the /schedule command
 ************************************************/
/**
 * For the /schedule slash command, we show rows that:
 *  - have ignore != "1"
 *  - if month != "All", item.month must match
 *  - if year != "All", item.year must match
 * Then we build an embed for each item using buildEmbedForItem.
 */
function createScheduleEmbeds(guildId, monthFilter = "All", yearFilter = "All") {
    const guildData = scheduleCache[guildId] || [];
    if (!guildData.length) {
        return [];
    }

    const monthLower = monthFilter.toLowerCase();
    const yearLower = yearFilter.toLowerCase();

    const filteredData = guildData.filter((item) => {
        if (item.ignore === "1") return false;

        const monthMatches =
            monthLower === "all" || item.month.toLowerCase() === monthLower;
        const yearMatches =
            yearLower === "all" || item.year.toLowerCase() === yearLower;

        return monthMatches && yearMatches;
    });

    // Build one embed per item
    return filteredData.map(buildEmbedForItem);
}

/************************************************
 * 7) Slash Command Registration
 ************************************************/
/**
 * Defines the slash commands:
 * 1) /schedule [month] [year]
 * 2) /refresh
 * 3) /resend
 * We then register them globally via the REST API.
 */
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
 * 8) Named Cron Jobs
 ************************************************/
/**
 * We store references to each cron job in `cronTasks` by name
 * (e.g. "main", "refresh"), so we can re-schedule them if the
 * CRONTIMER or REFRESHTIMER changes.
 */
let cronTasks = {};
let currentExpressions = {
  main: process.env.CRONTIMER,
  refresh: process.env.REFRESHTIMER
};

/**
 * scheduleCronJob: stops any existing job with the same name,
 * then creates a new job with the given cron expression
 * and callback function.
 */
function scheduleCronJob(jobName, cronExpression, callback) {
  if (cronTasks[jobName]) {
    cronTasks[jobName].stop();
    delete cronTasks[jobName];
  }
  console.log(`Scheduling "${jobName}" with CRON: "${cronExpression}"`);
  cronTasks[jobName] = cron.schedule(cronExpression, callback, { scheduled: true });
}

/**
 * initCronJobs: sets up the "main" job (fetch + remind) and the
 * "refresh" job (fetch only) using environment-based cron expressions.
 */
function initCronJobs() {
  // Job: main schedule refresh + reminders
  scheduleCronJob("main", currentExpressions.main, async () => {
    console.log(`Main cron job triggered at: ${new Date().toLocaleString()}`);
    await fetchScheduleData();
    sendScheduledReminders();
  });

  // Job: separate refresh (cache only)
  scheduleCronJob("refresh", currentExpressions.refresh, async () => {
    console.log(`Cache refresh job triggered at: ${new Date().toLocaleString()}`);
    await fetchScheduleData();
  });
}

/**
 * checkForEnvChanges: re-parses .env to see if CRONTIMER or REFRESHTIMER changed.
 * If so, it re-schedules the relevant cron job with the new expression.
 */
function checkForEnvChanges() {
  dotenv.config(); // re-load .env

  const newMain = process.env.CRONTIMER;
  const newRefresh = process.env.REFRESHTIMER;

  console.log(`[Checking Envs]: oldMain=${currentExpressions.main}, oldRefresh=${currentExpressions.refresh}`);
  console.log(`[New Envs]: newMain=${newMain}, newRefresh=${newRefresh}`);

  if (newMain && newMain !== currentExpressions.main) {
    console.log(`CRONTIMER changed from "${currentExpressions.main}" to "${newMain}"`);
    currentExpressions.main = newMain;
    scheduleCronJob("main", newMain, async () => {
      console.log(`Main cron job triggered at: ${new Date().toLocaleString()}`);
      await fetchScheduleData();
      sendScheduledReminders();
    });
  }

  if (newRefresh && newRefresh !== currentExpressions.refresh) {
    console.log(`REFRESHTIMER changed from "${currentExpressions.refresh}" to "${newRefresh}"`);
    currentExpressions.refresh = newRefresh;
    scheduleCronJob("refresh", newRefresh, async () => {
      console.log(`Cache refresh job triggered at: ${new Date().toLocaleString()}`);
      await fetchScheduleData();
    });
  }
}

/************************************************
 * 9) Bot Events & Startup
 ************************************************/
/**
 * Once the bot is ready, we:
 * 1) Register slash commands
 * 2) Fetch schedule data initially
 * 3) Optionally run reminders once immediately
 * 4) Initialize the named cron jobs
 * 5) Set up a cron job to check for .env changes
 * 6) Possibly schedule console clearing
 */
client.once("ready", async () => {
    console.log(`Logged in as ${client.user.tag}.`);
    console.log(`Current Server Date: ${getCurrentDateFormatted()}`)

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

    // Optionally do an immediate round of reminders if you want
    sendScheduledReminders();

    // Set up the cron tasks based on environment
    initCronJobs();

    // Re-check for .env changes every 1 minute
    // cron.schedule("*/1 * * * *", () => {
    //   console.log("[Env Reloader] Checking for updated CRONTIMER/REFRESHTIMER...");
    //   checkForEnvChanges();
    // });

    // If REFRESHTIMER is set, we can optionally clear the console on that schedule
    if (currentExpressions.refresh) {
      cron.schedule("*/30 * * * *", () => {
        console.clear();
      });
    }
});

/************************************************
 * 10) sendScheduledReminders()
 * Used to send notifications based on the reminder
 * dates for items that match "today"
 ************************************************/
async function sendScheduledReminders() {
    try {
        const guildIds = Object.keys(scheduleCache);

        for (const guildId of guildIds) {
            const guildData = scheduleCache[guildId];
            if (!guildData || !guildData.length) continue;

            // Attempt to find the guild object in Discord's cache
            const guild = client.guilds.cache.get(guildId);
            if (!guild) {
                console.log(`Bot not in guild ${guildId} or not cached.`);
                continue;
            }

            // Filter out items that need a reminder *today*
            const reminderItems = filterReminderItems(guildData);
            if (!reminderItems.length) continue;

            // We'll separate items by "reminderType"
            const channelPostItems = reminderItems.filter(
                i => i.reminderType.toLowerCase() === "channel post"
            );
            const privateMessageItems = reminderItems.filter(
                i => i.reminderType.toLowerCase() === "private message"
            );

            // 1) CHANNEL POST: group by channel
            const dataByChannel = {};
            for (const item of channelPostItems) {
                const chanKey = item.channel;
                if (!dataByChannel[chanKey]) {
                    dataByChannel[chanKey] = [];
                }
                dataByChannel[chanKey].push(item);
            }

            // Send one message per channel, bundling all relevant items
            for (const [channelNameOrId, items] of Object.entries(dataByChannel)) {
                const targetChannel = guild.channels.cache.find(
                    (ch) => ch.name === channelNameOrId || ch.id === channelNameOrId
                );
                if (!targetChannel) {
                    console.log(`Channel "${channelNameOrId}" not found in guild ${guildId}`);
                    continue;
                }

                const embedList = items.map(buildEmbedForItem);
                if (!embedList.length) continue;

                await targetChannel.send({
                    content: `Here is the schedule:`,
                    embeds: embedList,
                });
            }

            // 2) PRIVATE MESSAGE: group items by "creator" user
            const dataByUser = {};
            for (const item of privateMessageItems) {
                const userKey = item.creator; 
                if (!dataByUser[userKey]) {
                    dataByUser[userKey] = [];
                }
                dataByUser[userKey].push(item);
            }

            // Build and send one DM per user
            for (const [userId, items] of Object.entries(dataByUser)) {
                let user = null;
                try {
                    // Attempt to fetch the user by ID in this guild
                    user = await guild.members.fetch(userId);
                } catch (err) {
                    console.log(`Could not fetch user with ID "${userId}" in guild ${guildId}`);
                    continue;
                }

                if (!user) {
                    console.log(`No valid user found for item.creator = ${userId}`);
                    continue;
                }

                const embedList = items.map(buildEmbedForItem);
                if (!embedList.length) continue;

                try {
                    // DM the user with one combined message
                    await user.send({
                        content: `Here is your schedule reminder for today:`,
                        embeds: embedList,
                    });
                    console.log(`Sent a single private message to user ${user.id} with ${items.length} items.`);
                } catch (err) {
                    console.error(`Failed to DM user ${user.id}`, err);
                }
            }
        }
    } catch (err) {
        console.error("Error in sendScheduledReminders:", err);
    }
}

/************************************************
 * 11) Interaction Create: slash command
 ************************************************/
/**
 * Handles incoming slash commands:
 * - /schedule: shows the schedule for a month/year if user is admin or mod,
 *              only in valid channels listed in the sheet
 * - /refresh: forces a manual fetch from Google Sheets
 * - /resend: also re-fetches and triggers reminders again
 */
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const member = interaction.member;
    const isAdmin = member.permissions.has(PermissionsBitField.Flags.Administrator);
    const isMod = member.roles.cache.some(
        (role) => role.name.toLowerCase() === process.env.ROLE
    );

    // /schedule
    if (interaction.commandName === "schedule") {
        //if (!isAdmin && !isMod) {
        //    return interaction.reply({
        //        content: "You do not have permission to use this command!",
        //        ephemeral: true,
        //    });
        //}

        const guildId = interaction.guildId;
        const guildData = scheduleCache[guildId] || [];

        // Check that the user is in a channel that is in the sheet
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
            // If user provided a month / year, or default to 'All'
            const monthArg = interaction.options.getString("month") || "All";
            const yearArg = interaction.options.getString("year") || "All";

            // Filter schedule data for that month/year
            const embeds = createScheduleEmbeds(guildId, monthArg, yearArg);

            if (!embeds.length) {
                await interaction.reply({
                    content: `No schedule data found for month "${monthArg}" and year "${yearArg}".`,
                    ephemeral: true,
                });
                return;
            }

            await interaction.reply({
                content: `Showing schedule for Month: **${monthArg}**, Year: **${yearArg}**`,
                embeds: embeds,
                ephemeral: false,
            });
        } catch (err) {
            console.error("Error handling /schedule command:", err);
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp("An error occurred while processing your request.");
            } else {
                await interaction.reply("An error occurred while processing your request.");
            }
        }
    }

    // /refresh
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
                await interaction.followUp("An error occurred while refreshing the schedule data.");
            } else {
                await interaction.reply("An error occurred while refreshing the schedule data.");
            }
        }
    }

    // /resend
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
                await interaction.followUp("An error occurred while resending the schedule data.");
            } else {
                await interaction.reply("An error occurred while resending the schedule data.");
            }
        }
    }
});

/************************************************
 * 12) Login 
 * Starts the bot
 ************************************************/
client.login(process.env.DISCORD_TOKEN).catch((err) => {
    console.error("Failed to login to Discord:", err);
});
