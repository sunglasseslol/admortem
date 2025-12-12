const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

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

// Register slash command on startup
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
      .addStringOption((option) =>
        option.setName("role_id").setDescription("Role ID").setRequired(true),
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
      .addStringOption((option) =>
        option.setName("role_id").setDescription("Role ID").setRequired(true),
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

async function bulkAssignTest(pastebinId, roleId, interaction) {
  try {
    const pastebinRawUrl = `https://pastebin.com/raw/${pastebinId}`;
    const response = await fetch(pastebinRawUrl);
    if (!response.ok)
      throw new Error(
        `Failed to fetch pastebin data (status ${response.status})`,
      );
    const raw = await response.text();

    const userIds = raw
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter((x) => /^\d{17,19}$/.test(x));

    if (userIds.length === 0) {
      await interaction.editReply("No valid user IDs found in the pastebin.");
      return;
    }

    await interaction.editReply(
      `Starting to assign role to ${userIds.length} users...`,
    );

    const guild = interaction.guild;

    const chunkSize = 10;
    const delayMs = 2000;
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < userIds.length; i += chunkSize) {
      const chunk = userIds.slice(i, i + chunkSize);

      for (const id of chunk) {
        try {
          const member = await guild.members.fetch(id);
          // await member.roles.add(roleId);
          console.log(`Added ${roleId} to ${member.displayName}`);
          successCount++;
        } catch (err) {
          console.error(`Failed for user ID ${id}:`, err.message);
          failCount++;
        }
      }

      if (i + chunkSize < userIds.length) {
        await delay(delayMs);
      }
    }

    await interaction.followUp({
      content: `Finished! Successfully assigned roleID ${roleId} to ${successCount} users. Failed for ${failCount} users.`,
      ephemeral: true,
    });
  } catch (error) {
    console.error("Error during bulk assign:", error);
    await interaction.editReply(`Error: ${error.message}`);
  }
}

async function bulkAssign(pastebinId, roleId, interaction) {
  try {
    const pastebinRawUrl = `https://pastebin.com/raw/${pastebinId}`;
    const response = await fetch(pastebinRawUrl);
    if (!response.ok)
      throw new Error(
        `failed to fetch pastebin data (status ${response.status})`,
      );
    const raw = await response.text();

    const userIds = raw
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter((x) => /^\d{17,19}$/.test(x));

    if (userIds.length === 0) {
      await interaction.editReply("no valid user IDs found in the pastebin.");
      return;
    }

    await interaction.editReply(
      `starting to assign role to ${userIds.length} users`,
    );

    const guild = interaction.guild;

    const chunkSize = 10;
    const delayMs = 2000;
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < userIds.length; i += chunkSize) {
      const chunk = userIds.slice(i, i + chunkSize);

      for (const id of chunk) {
        try {
          const member = await guild.members.fetch(id);
          await member.roles.add(roleId);
          successCount++;
        } catch (err) {
          console.error(`Failed for user ID ${id}:`, err.message);
          failCount++;
        }
      }

      if (i + chunkSize < userIds.length) {
        await new Promise((res) => setTimeout(res, delayMs));
      }
    }

    await interaction.followUp({
      content: `successfully assigned roleID ${roleId} to ${successCount} users. failed for ${failCount} users.`,
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
  const roleId = interaction.options.getString("role_id");

  await interaction.deferReply({ ephemeral: true });

  if (interaction.commandName == "bulkassign") {
    bulkAssign(pastebinId, roleId, interaction);
  }
  if (interaction.commandName == "bulkassigntest") {
    bulkAssignTest(pastebinId, roleId, interaction);
  }
});

if (!TOKEN) {
  console.error(
    "error: no token provided. usage: node yourScript.js <BOT_TOKEN>",
  );
  process.exit(1);
}

client.login(TOKEN);
