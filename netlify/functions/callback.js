const axios = require('axios');
const mongoose = require('mongoose');

let cachedDb = null;
async function connectToDatabase(uri) {
  if (cachedDb) return cachedDb;
  const conn = await mongoose.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true });
  cachedDb = conn;
  return conn;
}

const VerifiedUserSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  guildId: { type: String, required: true },
  accessToken: { type: String, required: true },
  refreshToken: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  verifiedAt: { type: Date, default: Date.now },
  addedServers: { type: [String], default: [] }
});
VerifiedUserSchema.index({ userId: 1, guildId: 1 }, { unique: true });
const VerifiedUser = mongoose.models.VerifiedUser || mongoose.model('VerifiedUser', VerifiedUserSchema);

const GuildConfigSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  verifiedRoleId: { type: String, default: null }
});
const GuildConfig = mongoose.models.GuildConfig || mongoose.model('GuildConfig', GuildConfigSchema);

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  const { code, state } = event.queryStringParameters || {};
  if (!code || !state) {
    return { statusCode: 400, body: 'Missing code or state parameter.' };
  }

  const guildId = state;
  const { CLIENT_ID, CLIENT_SECRET, REDIRECT_URI, BOT_TOKEN, MONGODB_URI } = process.env;

  try {
    await connectToDatabase(MONGODB_URI);

    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    });

    const tokenRes = await axios.post(
      'https://discord.com/api/oauth2/token',
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, refresh_token, expires_in } = tokenRes.data;

    const userRes = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const { id: userId, username } = userRes.data;

    await axios.put(`https://discord.com/api/guilds/${guildId}/members/${userId}`,
      { access_token },
      { headers: { Authorization: `Bot ${BOT_TOKEN}` } }
    );

    await VerifiedUser.findOneAndUpdate(
      { userId, guildId },
      {
        userId,
        guildId,
        accessToken: access_token,
        refreshToken: refresh_token,
        expiresAt: new Date(Date.now() + expires_in * 1000),
        verifiedAt: new Date(),
      },
      { upsert: true, new: true }
    );

    const guildConfig = await GuildConfig.findOne({ guildId });
    if (guildConfig && guildConfig.verifiedRoleId) {
      try {
        await axios.put(
          `https://discord.com/api/guilds/${guildId}/members/${userId}/roles/${guildConfig.verifiedRoleId}`,
          {},
          { headers: { Authorization: `Bot ${BOT_TOKEN}` } }
        );
      } catch (roleErr) {
        console.error('Role assignment failed:', roleErr.response?.data || roleErr.message);
      }
    }

    try {
      const dm = await axios.post(
        `https://discord.com/api/users/@me/channels`,
        { recipient_id: userId },
        { headers: { Authorization: `Bot ${BOT_TOKEN}` } }
      );
      await axios.post(
        `https://discord.com/api/channels/${dm.data.id}/messages`,
        { content: `✅ You have successfully verified in the server!` },
        { headers: { Authorization: `Bot ${BOT_TOKEN}` } }
      );
    } catch (dmErr) {
      console.error('DM failed:', dmErr.response?.data || dmErr.message);
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html' },
      body: `
        <html>
          <head><title>Verified!</title></head>
          <body style="font-family:Arial; text-align:center; padding-top:50px;">
            <h1>✅ Verification Successful!</h1>
            <p>Thanks, ${username}! You have been verified and added to the server.</p>
            <p>You can now close this tab and return to Discord.</p>
          </body>
        </html>
      `,
    };
  } catch (err) {
    console.error('Callback error:', {
      message: err.message,
      response: err.response?.data,
      status: err.response?.status,
    });
    return {
      statusCode: 500,
      body: '❌ Verification failed. Please try again later.',
    };
  }
};
