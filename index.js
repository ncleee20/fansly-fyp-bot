const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');

// ── Config ──
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;

// ── Topic IDs ──
const TOPICS = {
  research: 3,
  lola: 4,
  josie: 5,
  emma: 6,
  akasha: 7,
  myla: 8,
  grace: 9,
  mia: 10
};

const MODEL_NAMES = ['lola', 'josie', 'emma', 'akasha', 'myla', 'grace', 'mia'];

// ── Init ──
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

console.log('🤖 Fansly FYP Bot is running...');

// ── Helper: get all people from Supabase ──
async function getPeople() {
  const { data } = await supabase.from('people').select('*').order('id');
  return data || [];
}

// ── Helper: get all videos from Supabase ──
async function getVideos() {
  const { data } = await supabase.from('videos').select('*').order('id');
  return data || [];
}

// ── Helper: mark video as sent to model in Supabase ──
async function markSent(videoId, personId, isSent) {
  await supabase.from('sent_status').upsert({
    video_id: videoId,
    person_id: personId,
    is_sent: isSent
  }, { onConflict: 'video_id,person_id' });
}

// ── Helper: find video by research number or name ──
async function findVideo(query) {
  const videos = await getVideos();
  // Try by number first (e.g. "5" or "#5")
  const num = parseInt(query.replace('#', ''));
  if (!isNaN(num)) {
    // Sort numerically to match app order
    const sorted = [...videos].sort((a, b) => {
      const na = parseInt(a.name.match(/\d+/)?.[0]) || 999999;
      const nb = parseInt(b.name.match(/\d+/)?.[0]) || 999999;
      return na - nb;
    });
    if (sorted[num - 1]) return sorted[num - 1];
  }
  // Try by name match
  return videos.find(v => v.name.toLowerCase().includes(query.toLowerCase()));
}

// ── Helper: find person by name ──
async function findPerson(name) {
  const people = await getPeople();
  return people.find(p => p.name.toLowerCase() === name.toLowerCase());
}

// ── Helper: forward a video message to a topic ──
async function forwardToTopic(fromMessageId, toTopicId) {
  try {
    await bot.forwardMessage(
      GROUP_CHAT_ID,
      GROUP_CHAT_ID,
      fromMessageId,
      { message_thread_id: toTopicId }
    );
    return true;
  } catch (e) {
    console.error('Forward error:', e.message);
    return false;
  }
}

// ── Command: /send research#N modelname ──
// Example: /send research#5 lola
// Example: /send #5 lola grace myla
bot.onText(/\/send (.+)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id;
  const args = match[1].trim().toLowerCase().split(/\s+/);

  if (args.length < 2) {
    return bot.sendMessage(chatId,
      '❌ Usage: /send research#N modelname\nExample: /send research#5 lola\nExample: /send #5 lola grace',
      { message_thread_id: threadId }
    );
  }

  // Parse research video reference
  const videoRef = args[0].replace('research', '');
  const modelNames = args.slice(1);

  // Find the video
  const video = await findVideo(videoRef);
  if (!video) {
    return bot.sendMessage(chatId,
      `❌ Could not find video: "${args[0]}"\nUse the research number e.g. /send #5 lola`,
      { message_thread_id: threadId }
    );
  }

  // Find the message with the actual video in Research topic
  // We'll forward the original message if provided, otherwise just mark as sent
  let results = [];

  for (const modelName of modelNames) {
    if (!MODEL_NAMES.includes(modelName)) {
      results.push(`❌ Unknown model: ${modelName}`);
      continue;
    }

    const person = await findPerson(modelName);
    if (!person) {
      results.push(`❌ Could not find ${modelName} in database`);
      continue;
    }

    // Mark as sent in Supabase
    await markSent(video.id, person.id, true);
    results.push(`✅ ${video.name} → ${person.name}`);
  }

  const response = `📤 *Send Report*\n\n${results.join('\n')}\n\n_App updated automatically_`;
  bot.sendMessage(chatId, response, {
    message_thread_id: threadId,
    parse_mode: 'Markdown'
  });
});

// ── Command: /forward msgID modelname ──
// Use this when you want to actually forward the video to the model's topic
// First find the message ID of the video in Research, then run this
bot.onText(/\/forward (\d+) (.+)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id;
  const messageId = parseInt(match[1]);
  const modelNames = match[2].trim().toLowerCase().split(/\s+/);

  let results = [];

  for (const modelName of modelNames) {
    if (!MODEL_NAMES.includes(modelName)) {
      results.push(`❌ Unknown model: ${modelName}`);
      continue;
    }

    const topicId = TOPICS[modelName];
    const success = await forwardToTopic(messageId, topicId);
    results.push(success ? `✅ Forwarded to ${modelName}` : `❌ Failed to forward to ${modelName}`);
  }

  bot.sendMessage(chatId, results.join('\n'), { message_thread_id: threadId });
});

// ── Command: /status ──
// Shows overall tracker stats
bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id;

  const [videos, people, { data: sentData }] = await Promise.all([
    getVideos(),
    getPeople(),
    supabase.from('sent_status').select('*').eq('is_sent', true)
  ]);

  const total = videos.length * people.length;
  const sent = sentData?.length || 0;
  const pct = total ? Math.round(sent / total * 100) : 0;

  let modelStats = '';
  for (const person of people) {
    const personSent = sentData?.filter(s => s.person_id === person.id).length || 0;
    const bar = '█'.repeat(Math.round(personSent / videos.length * 10)) + '░'.repeat(10 - Math.round(personSent / videos.length * 10));
    modelStats += `\n${bar} *${person.name}*: ${personSent}/${videos.length}`;
  }

  const response = `📊 *Fansly FYP Tracker Status*\n\n🎬 Research Videos: ${videos.length}\n👥 Models: ${people.length}\n✅ Sent: ${sent}/${total} (${pct}%)\n\n*Per Model:*${modelStats}`;

  bot.sendMessage(chatId, response, {
    message_thread_id: threadId,
    parse_mode: 'Markdown'
  });
});

// ── Command: /unsend research#N modelname ──
bot.onText(/\/unsend (.+)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id;
  const args = match[1].trim().toLowerCase().split(/\s+/);

  if (args.length < 2) {
    return bot.sendMessage(chatId,
      '❌ Usage: /unsend research#N modelname\nExample: /unsend #5 lola',
      { message_thread_id: threadId }
    );
  }

  const videoRef = args[0].replace('research', '');
  const modelNames = args.slice(1);
  const video = await findVideo(videoRef);

  if (!video) {
    return bot.sendMessage(chatId,
      `❌ Could not find video: "${args[0]}"`,
      { message_thread_id: threadId }
    );
  }

  let results = [];
  for (const modelName of modelNames) {
    const person = await findPerson(modelName);
    if (!person) { results.push(`❌ Unknown: ${modelName}`); continue; }
    await markSent(video.id, person.id, false);
    results.push(`↩️ ${video.name} → ${person.name} marked unsent`);
  }

  bot.sendMessage(chatId, results.join('\n'), {
    message_thread_id: threadId,
    parse_mode: 'Markdown'
  });
});

// ── Command: /list modelname ──
// Shows all videos sent to a specific model
bot.onText(/\/list (.+)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id;
  const modelName = match[1].trim().toLowerCase();

  const person = await findPerson(modelName);
  if (!person) {
    return bot.sendMessage(chatId, `❌ Unknown model: ${modelName}`, { message_thread_id: threadId });
  }

  const videos = await getVideos();
  const { data: sentData } = await supabase
    .from('sent_status')
    .select('*')
    .eq('person_id', person.id)
    .eq('is_sent', true);

  const sorted = [...videos].sort((a, b) => {
    const na = parseInt(a.name.match(/\d+/)?.[0]) || 999999;
    const nb = parseInt(b.name.match(/\d+/)?.[0]) || 999999;
    return na - nb;
  });

  const sentVideoIds = sentData?.map(s => s.video_id) || [];
  const sentVideos = sorted.filter(v => sentVideoIds.includes(v.id));

  if (sentVideos.length === 0) {
    return bot.sendMessage(chatId, `📭 No videos sent to ${person.name} yet.`, { message_thread_id: threadId });
  }

  let list = sentVideos.map((v, i) => {
    const researchNum = sorted.indexOf(v) + 1;
    return `${i + 1}. Fansly Video ${i + 1} _(Research #${researchNum}: ${v.name})_`;
  }).join('\n');

  bot.sendMessage(chatId,
    `📋 *${person.name}'s Videos* (${sentVideos.length} total)\n\n${list}`,
    { message_thread_id: threadId, parse_mode: 'Markdown' }
  );
});

// ── Command: /help ──
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id;
  const help = `🤖 *Fansly FYP Bot Commands*

/send #N model1 model2 ...
_Mark research video #N as sent to models_
Example: \`/send #5 lola grace\`

/unsend #N model1 model2 ...
_Mark research video #N as unsent_
Example: \`/unsend #5 lola\`

/forward msgID model1 model2 ...
_Forward a video message to model topics_
Example: \`/forward 123 lola grace\`

/list modelname
_Show all videos sent to a model_
Example: \`/list lola\`

/status
_Show overall tracker stats_

Models: lola, josie, emma, akasha, myla, grace, mia`;

  bot.sendMessage(chatId, help, {
    message_thread_id: threadId,
    parse_mode: 'Markdown'
  });
});
