const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");
const fs = require("fs/promises");
const path = require("path");

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

const rest = new REST({ version: "10" }).setToken(TOKEN);

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
 * Assigns a role to a single user with verification.
 * Uses REST API directly for optimal rate limit handling.
 * Discord.js REST manager automatically respects X-RateLimit-* headers.
 * Returns { success: boolean, userId, error?: string }
 */
async function assignRoleToUser(guildId, userId, roleId, dryRun = false) {
  try {
    if (!dryRun) {
      await rest.put(
        Routes.guildMemberRole(guildId, userId, roleId),
        { reason: "Bulk role assignment" }
      );
    }

    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      return { success: false, userId, error: "Guild not found" };
    }
    
    const member = await guild.members.fetch({ user: userId, force: true });
    if (!member) {
      return { success: false, userId, error: "Member not found after assignment" };
    }

    // Check if role is actually added
    const hasRole = member.roles.cache.has(roleId);
    if (!dryRun && !hasRole) {
      return { success: false, userId, error: "Role not found after assignment - verification failed" };
    }

    return { success: true, userId };
  } catch (err) {
    if (err.status === 429) {
      console.warn(`Rate limited for user ${userId}, will retry automatically`);
      throw err;
    }
    return { success: false, userId, error: err.message };
  }
}

/**
 * Main bulk assign runner with rate limiting. Also checks if the user has the role after adding it
 * X-RateLimit-* headers are used for rate limiting.
 * @param {string} pastebinId
 * @param {object} role
 * @param {object} interaction
 * @param {boolean} dryRun (default: false) - If true, doesn't actually assign the roles; just tests fetches.
 */
async function bulkAssignUsersFromPastebin(pastebinId, role, interaction, dryRun = false) {
  const logFilePath = path.join(process.cwd(), "lastrun.txt");
  let logFileHandle = null;

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
        `starting to assign role to ${userIds.length} users (optimized rate limiting enabled)`,
      );
      // Open log file for appending successful assignments
      try {
        await fs.writeFile(logFilePath, "", "utf-8"); // Clear previous run
        logFileHandle = true; // Flag to indicate file is ready
      } catch (fileError) {
        console.error("Failed to open log file:", fileError);
      }
    }

    const guildId = interaction.guild.id;
    let successCount = 0;
    let failCount = 0;
    const failedUserIds = [];

    for (let i = 0; i < userIds.length; i++) {
      const userId = userIds[i];
      
      try {
        const result = await assignRoleToUser(guildId, userId, role.id, dryRun);
        
        if (result.success) {
          successCount++;
          
          // Log successful assignment immediately to file
          if (!dryRun && logFileHandle) {
            try {
              await fs.appendFile(logFilePath, `${userId}\n`, "utf-8");
              console.log(`✓ ${userId} - Role "${role.name}" verified and logged`);
            } catch (logError) {
              console.error(`Failed to log ${userId}:`, logError);
            }
          } else if (dryRun) {
            console.log(`✓ ${userId} - Would be assigned (dry run)`);
          }
        } else {
          failCount++;
          failedUserIds.push({ userId, error: result.error });
          console.error(`✗ ${userId} - ${result.error}`);
        }
      } catch (err) {
        if (err.status === 429) {
          console.warn(`Rate limit hit for ${userId}, REST manager will handle retry`);
          try {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const retryResult = await assignRoleToUser(guildId, userId, role.id, dryRun);
            if (retryResult.success) {
              successCount++;
              if (!dryRun && logFileHandle) {
                await fs.appendFile(logFilePath, `${userId}\n`, "utf-8");
                console.log(`✓ ${userId} - Role assigned after retry`);
              }
            } else {
              failCount++;
              failedUserIds.push({ userId, error: retryResult.error || "Rate limit retry failed" });
            }
          } catch (retryErr) {
            failCount++;
            failedUserIds.push({ userId, error: `Rate limit retry failed: ${retryErr.message}` });
            console.error(`✗ ${userId} - Retry failed:`, retryErr.message);
          }
        } else {
          failCount++;
          failedUserIds.push({ userId, error: err.message });
          console.error(`✗ ${userId} - Error:`, err.message);
        }
      }

      // Progress update every 50 users
      if ((i + 1) % 50 === 0) {
        const progress = ((i + 1) / userIds.length * 100).toFixed(1);
        console.log(`Progress: ${i + 1}/${userIds.length} (${progress}%) - Success: ${successCount}, Failed: ${failCount}`);
      }
    }

    if (logFileHandle) {
      console.log(`\nLogged ${successCount} successful user IDs to lastrun.txt`);
    }

    let summary = dryRun
      ? `Dry run complete: able to fetch ${successCount} users. failed for ${failCount} users`
      : `Successfully assigned "${role.name}" role to ${successCount} users. failed for ${failCount} users`;

    if (failedUserIds.length > 0 && failedUserIds.length <= 10) {
      summary += `\n\nFailed users:\n${failedUserIds.map(f => `- ${f.userId}: ${f.error}`).join("\n")}`;
    } else if (failedUserIds.length > 10) {
      summary += `\n\nFirst 10 failed users:\n${failedUserIds.slice(0, 10).map(f => `- ${f.userId}: ${f.error}`).join("\n")}\n... and ${failedUserIds.length - 10} more`;
    }

    await interaction.followUp({
      content: summary,
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
