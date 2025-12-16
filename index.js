const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");
const fs = require("fs/promises");

const TOKEN = process.argv[2];
const CLIENT_ID = "1448983823781072951";
const GUILD_ID = "1448975847657836668";

const ALLOWED_USER_IDS = ["388931035607597057", "302642984560885762"];
const ALLOWED_ROLE_IDS = [
  "735479013522276412",
  "1142947458285060096",
  "735463085489389621",
];

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember],
});

async function registerCommand() {
  const commands = [
    new SlashCommandBuilder()
      .setName("bulkassign")  
      .setDescription("Bulk assign a role to users listed in a Pastebin raw")
      .addStringOption((option) =>
        option
          .setName("pastebin_id")
          .setDescription("Pastebin ID containing user IDs, one per line")
          .setRequired(true),
      )
      .addRoleOption((option) =>
        option.setName("role").setDescription("Role").setRequired(true),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("bulkassigntest")
      .setDescription("Test the bulk assign command")
      .addStringOption((option) =>
        option
          .setName("pastebin_id")
          .setDescription("Pastebin ID containing user IDs, one per line")
          .setRequired(true),
      )
      .addRoleOption((option) =>
        option.setName("role").setDescription("Role").setRequired(true),
      )
      .toJSON(),
  ];

  const rest = new REST({ version: "10" }).setToken(TOKEN);

  try {
    console.log("Registering slash command...");
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body: commands,
    });
    console.log("Slash command registered.");
  } catch (error) {
    console.error("Failed to register slash command:", error);
  }
}

client.once("clientReady", async () => {
  console.log(`logged in as ${client.user.tag}`);
  await registerCommand();
});

/**
 * Fetches the raw content from a Pastebin and returns an array of valid user IDs.
 * @param {string} pastebinId
 * @returns {Promise<string[]>}
 */
async function fetchUserIdsFromPastebin(pastebinId) {
  const pastebinRawUrl = `https://pastebin.com/raw/${pastebinId}`;
  const response = await fetch(pastebinRawUrl);
  if (!response.ok)
    throw new Error(
      `failed to fetch pastebin data (status ${response.status})`,
    );
  const raw = await response.text();
  return raw
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter((x) => /^\d{17,19}$/.test(x));
}

/**
 * Assigns a role to a given chunk of user IDs.
 * If dryRun is true, only fetches the members without actually adding the role.
 * Returns { successCount, failCount, successfulUserIds }
 */
async function processUserChunk(guild, userIds, role, dryRun = false) {
  let successCount = 0;
  let failCount = 0;
  const successfulUserIds = [];

  for (const id of userIds) {
    try {
      const member = await guild.members.fetch(id);
      if (!dryRun) {
        await member.roles.add(role.id);
      }
      successCount++;
      successfulUserIds.push(id);
    } catch (err) {
      console.error(`Failed for user ID ${id}:`, err.message);
      failCount++;
    }
  }
  return { successCount, failCount, successfulUserIds };
}

/**
 * Main bulk assign runner.
 * @param {string} pastebinId
 * @param {object} role
 * @param {object} interaction
 * @param {boolean} dryRun (default: false) - If true, doesn't actually assign the roles; just tests fetches.
 */
async function bulkAssignUsersFromPastebin(pastebinId, role, interaction, dryRun = false) {
  try {
    const userIds = await fetchUserIdsFromPastebin(pastebinId);

    if (userIds.length === 0) {
      await interaction.editReply("no valid user IDs found in the pastebin.");
      return;
    }

    if (dryRun) {
      await interaction.editReply(
        `starting dry run: testing fetching ${userIds.length} users`
      );
    } else {
      await interaction.editReply(
        `starting to assign role to ${userIds.length} users`,
      );
    }

    const guild = interaction.guild;
    const chunkSize = 10;
    const delayMs = 2000;
    let successCount = 0;
    let failCount = 0;
    const allSuccessfulUserIds = [];

    for (let i = 0; i < userIds.length; i += chunkSize) {
      const chunk = userIds.slice(i, i + chunkSize);

      const { successCount: chunkSuccess, failCount: chunkFail, successfulUserIds } =
        await processUserChunk(guild, chunk, role, dryRun);

      successCount += chunkSuccess;
      failCount += chunkFail;
      allSuccessfulUserIds.push(...successfulUserIds);

      if (i + chunkSize < userIds.length) {
        await new Promise((res) => setTimeout(res, delayMs));
      }
    }

    // Write successful user IDs to file (only for actual role assignments, not dry runs)
    if (!dryRun && allSuccessfulUserIds.length > 0) {
      try {
        await fs.writeFile("lastrun.txt", allSuccessfulUserIds.join("\n"), "utf-8");
        console.log(`Logged ${allSuccessfulUserIds.length} successful user IDs to lastrun.txt`);
      } catch (fileError) {
        console.error("Failed to write to lastrun.txt:", fileError);
      }
    }

    await interaction.followUp({
      content: dryRun
        ? `dry run complete: able to fetch ${successCount} users. failed for ${failCount} users`
        : `successfully assigned "${role.name}" role to ${successCount} users. failed for ${failCount} users`,
      ephemeral: true,
    });
  } catch (error) {
    console.error("error during bulk assign:", error);
    await interaction.editReply(`Error: ${error.message}`);
  }
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const member = interaction.member;

  if (!member) {
    await interaction.reply({
      content: "could not fetch your member data.",
      ephemeral: true,
    });
    return;
  }

  if (
    !ALLOWED_USER_IDS.includes(interaction.user.id) &&
    !ALLOWED_ROLE_IDS.some((roleId) => member.roles.cache.has(roleId))
  ) {
    await interaction.reply({
      content: "You don't have permission to use this command.",
      ephemeral: true,
    });
    return;
  }

  const pastebinId = interaction.options.getString("pastebin_id");
  const role = interaction.options.getRole("role");

  await interaction.deferReply({ ephemeral: true });

  if (interaction.commandName == "bulkassign") {
    bulkAssignUsersFromPastebin(pastebinId, role, interaction);
  }
  if (interaction.commandName == "bulkassigntest") {
    bulkAssignUsersFromPastebin(pastebinId, role, interaction, true);
  }
});

if (!TOKEN) {
  console.error(
    "error: no token provided. usage: node yourScript.js <BOT_TOKEN>",
  );
  process.exit(1);
}

client.login(TOKEN);
