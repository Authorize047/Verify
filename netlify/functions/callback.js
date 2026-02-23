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
    console.log('✅ Connected to MongoDB');

    // 1. Exchange code for token
    let tokenRes;
    try {
      const params = new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
      });
      tokenRes = await axios.post(
        'https://discord.com/api/oauth2/token',
        params.toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      console.log('✅ Token exchange successful');
    } catch (err) {
      console.error('❌ Token exchange failed:', {
        status: err.response?.status,
        data: err.response?.data,
        message: err.message
      });
      throw err;
    }

    const { access_token, refresh_token, expires_in } = tokenRes.data;

    // 2. Get user info
    let userRes;
    try {
      userRes = await axios.get('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      console.log('✅ User info fetched');
    } catch (err) {
      console.error('❌ Failed to fetch user info:', err.response?.data || err.message);
      throw err;
    }
    const { id: userId, username } = userRes.data;

    // 3. Add user to guild
    try {
      await axios.put(`https://discord.com/api/guilds/${guildId}/members/${userId}`,
        { access_token },
        { headers: { Authorization: `Bot ${BOT_TOKEN}` } }
      );
      console.log('✅ User added to guild');
    } catch (err) {
      console.error('❌ Failed to add user to guild:', {
        status: err.response?.status,
        data: err.response?.data,
        message: err.message
      });
      throw err;
    }

    // 4. Save verification record
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
    console.log('✅ Verification record saved');

    // 5. Assign role if configured
    const guildConfig = await GuildConfig.findOne({ guildId });
    if (guildConfig && guildConfig.verifiedRoleId) {
      try {
        await axios.put(
          `https://discord.com/api/guilds/${guildId}/members/${userId}/roles/${guildConfig.verifiedRoleId}`,
          {},
          { headers: { Authorization: `Bot ${BOT_TOKEN}` } }
        );
        console.log('✅ Role assigned');
      } catch (roleErr) {
        console.error('❌ Role assignment failed:', roleErr.response?.data || roleErr.message);
      }
    }

    // 6. Fetch guild name for DM
    let guildName = 'the server';
    try {
      const guildRes = await axios.get(`https://discord.com/api/guilds/${guildId}`, {
        headers: { Authorization: `Bot ${BOT_TOKEN}` }
      });
      guildName = guildRes.data.name;
    } catch (guildErr) {
      console.error('❌ Failed to fetch guild name:', guildErr.message);
    }

    // 7. Send DM with enhanced message
    try {
      const dm = await axios.post(
        `https://discord.com/api/users/@me/channels`,
        { recipient_id: userId },
        { headers: { Authorization: `Bot ${BOT_TOKEN}` } }
      );
      await axios.post(
        `https://discord.com/api/channels/${dm.data.id}/messages`,
        { content: `✅ **Verified Successfully!**\n\n${username}, you have been successfully verified in **${guildName}**!` },
        { headers: { Authorization: `Bot ${BOT_TOKEN}` } }
      );
      console.log('✅ DM sent');
    } catch (dmErr) {
      console.error('❌ DM failed:', dmErr.response?.data || dmErr.message);
    }

    // Return enhanced success HTML page
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: `
        <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>✅ Verified!</title>
            <style>
              body {
                font-family: Arial, sans-serif;
                text-align: center;
                padding-top: 50px;
                background-color: #f0f2f5;
              }
              .container {
                max-width: 500px;
                margin: 0 auto;
                background: white;
                padding: 30px;
                border-radius: 10px;
                box-shadow: 0 2px 10px rgba(0,0,0,0.1);
              }
              h1 { color: #28a745; }
            </style>
          </head>
          <body>
            <div class="container">
              <h1>✅ Verification Successful!</h1>
              <p>Thanks, ${username}! You have been verified and added to <strong>${guildName}</strong>.</p>
              <p>You can now close this tab and return to Discord.</p>
            </div>
          </body>
        </html>
      `,
    };
  } catch (err) {
    console.error('❌ Fatal error:', err.message);
    return {
      statusCode: 500,
      body: '❌ Verification failed. Please try again later.',
    };
  }
};
