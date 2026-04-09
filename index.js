const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const https = require('https');
const http = require('http');

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

// ── Helpers ──
async function getPeople() {
  const { data } = await supabase.from('people').select('*').order('id');
  return data || [];
}

async function getVideos() {
  const { data } = await supabase.from('videos').select('*').order('id');
  return data || [];
}

async function getSortedVideos() {
  const videos = await getVideos();
  return [...videos].sort((a, b) => {
    const na = parseInt(a.name.replace(/[^0-9]/g, '')) || 999999;
    const nb = parseInt(b.name.replace(/[^0-9]/g, '')) || 999999;
    return na - nb;
  });
}

async function markSent(videoId, personId, isSent) {
  await supabase.from('sent_status').upsert({
    video_id: videoId, person_id: personId, is_sent: isSent
  }, { onConflict: 'video_id,person_id' });
}

async function findVideo(query) {
  const videos = await getSortedVideos();
  const num = parseInt(query.replace(/[^0-9]/g, ''));
  if (!isNaN(num) && num > 0) {
    const found = videos.find(v => parseInt(v.name.replace(/[^0-9]/g, '')) === num);
    if (found) return found;
    if (videos[num - 1]) return videos[num - 1];
  }
  return videos.find(v => v.name.toLowerCase().includes(query.toLowerCase()));
}

async function findPerson(name) {
  const people = await getPeople();
  return people.find(p => p.name.toLowerCase() === name.toLowerCase());
}

async function getNextResearchNumber() {
  const { data } = await supabase
    .from('message_tags')
    .select('research_num')
    .order('research_num', { ascending: false })
    .limit(1);
  if (data && data.length > 0) return data[0].research_num + 1;
  return 1;
}

async function saveMessageTag(messageId, researchNum, videoId) {
  await supabase.from('message_tags').upsert({
    message_id: messageId, research_num: researchNum, video_id: videoId
  }, { onConflict: 'message_id' });
}

async function forwardToTopic(fromMessageId, toTopicId) {
  try {
    await bot.forwardMessage(GROUP_CHAT_ID, GROUP_CHAT_ID, fromMessageId, { message_thread_id: toTopicId });
    return true;
  } catch (e) {
    console.error('Forward error:', e.message);
    return false;
  }
}

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function saveThumbnail(msg, videoId, researchNum) {
  try {
    let fileId = null;
    if (msg.video?.thumb?.file_id) fileId = msg.video.thumb.file_id;
    else if (msg.video?.thumbnail?.file_id) fileId = msg.video.thumbnail.file_id;
    else if (msg.document?.thumb?.file_id) fileId = msg.document.thumb.file_id;
    else if (msg.document?.thumbnail?.file_id) fileId = msg.document.thumbnail.file_id;
    if (!fileId) return null;

    const file = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const buffer = await downloadBuffer(fileUrl);
    const fileName = `research_${researchNum}_${Date.now()}.jpg`;

    const { error } = await supabase.storage.from('thumbnails').upload(fileName, buffer, { contentType: 'image/jpeg', upsert: true });
    if (error) { console.error('Storage error:', error); return null; }

    const { data: urlData } = supabase.storage.from('thumbnails').getPublicUrl(fileName);
    await supabase.from('videos').update({ thumbnail: urlData.publicUrl }).eq('id', videoId);
    console.log(`✅ Thumbnail saved for Research #${researchNum}`);
    return urlData.publicUrl;
  } catch (e) {
    console.error('Thumbnail error:', e.message);
    return null;
  }
}

// ── SUPABASE REALTIME: Watch sent_status for toggle changes ──
async function startRealtimeListener() {
  console.log('👂 Starting Supabase Realtime listener...');

  const channel = supabase
    .channel('sent_status_changes')
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'sent_status',
      filter: 'is_sent=eq.true'
    }, async (payload) => {
      try {
        const { video_id, person_id } = payload.new;
        console.log(`🔔 Toggle detected: video_id=${video_id}, person_id=${person_id}`);

        // Get video and person details
        const { data: video } = await supabase.from('videos').select('*').eq('id', video_id).single();
        const { data: person } = await supabase.from('people').select('*').eq('id', person_id).single();

        if (!video || !person) {
          console.error('Could not find video or person');
          return;
        }

        // Get the tagged message for this video
        const { data: tag } = await supabase
          .from('message_tags')
          .select('message_id')
          .eq('video_id', video_id)
          .single();

        if (!tag) {
          console.log(`⚠️ No tagged message found for ${video.name} — video not uploaded to Research topic yet`);
          // Send notification to Research topic
          bot.sendMessage(GROUP_CHAT_ID,
            `⚠️ *Toggle detected for ${video.name} → ${person.name}*\n\nBut this video hasn't been uploaded to the Research topic yet!\nPlease upload it first so the bot can forward it.`,
            { message_thread_id: TOPICS.research, parse_mode: 'Markdown' }
          );
          return;
        }

        // Get model's topic ID
        const modelKey = person.name.toLowerCase();
        const topicId = TOPICS[modelKey];

        if (!topicId) {
          console.error(`No topic ID found for model: ${person.name}`);
          return;
        }

        // Forward the video to the model's topic
        console.log(`📤 Forwarding ${video.name} to ${person.name}'s topic...`);
        const success = await forwardToTopic(tag.message_id, topicId);

        if (success) {
          console.log(`✅ Successfully forwarded ${video.name} to ${person.name}`);
          // Send confirmation to Research topic
          bot.sendMessage(GROUP_CHAT_ID,
            `✅ *Auto-forwarded*\n${video.name} → ${person.name}`,
            { message_thread_id: TOPICS.research, parse_mode: 'Markdown' }
          );
        } else {
          console.error(`❌ Failed to forward ${video.name} to ${person.name}`);
        }

      } catch (e) {
        console.error('Realtime handler error:', e);
      }
    })
    .subscribe((status) => {
      console.log(`Realtime subscription status: ${status}`);
    });

  return channel;
}

// ── AUTO-TAG videos posted in Research topic ──
bot.on('message', async (msg) => {
  if (String(msg.chat.id) !== String(GROUP_CHAT_ID)) return;
  if (msg.message_thread_id !== TOPICS.research) return;
  const isVideo = msg.video || msg.document?.mime_type?.startsWith('video/');
  if (!isVideo) return;
  if (msg.from?.is_bot) return;
  if (msg.text?.startsWith('/')) return;

  try {
    const nextNum = await getNextResearchNumber();
    const video = await findVideo(String(nextNum));

    if (!video) {
      return bot.sendMessage(GROUP_CHAT_ID,
        `⚠️ Research #${nextNum} not found in database.`,
        { message_thread_id: TOPICS.research, reply_to_message_id: msg.message_id }
      );
    }

    await saveMessageTag(msg.message_id, nextNum, video.id);
    const thumbUrl = await saveThumbnail(msg, video.id, nextNum);
    const thumbStatus = thumbUrl ? '🖼 Thumbnail saved ✅' : '🖼 No thumbnail available';

    bot.sendMessage(GROUP_CHAT_ID,
      `📹 *Tagged as Research #${nextNum}*\n${thumbStatus}\n\nToggle in the app to send to models — bot will forward automatically!`,
      { message_thread_id: TOPICS.research, reply_to_message_id: msg.message_id, parse_mode: 'Markdown' }
    );
  } catch (e) {
    console.error('Auto-tag error:', e);
  }
});

// ── /send #N model1 model2 ... | all ──
bot.onText(/\/send (.+)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id;
  const args = match[1].trim().toLowerCase().split(/\s+/);
  if (args.length < 2) return bot.sendMessage(chatId, '❌ Usage: /send #N modelname or /send #N all', { message_thread_id: threadId });

  const video = await findVideo(args[0]);
  if (!video) return bot.sendMessage(chatId, `❌ Could not find video: "${args[0]}"`, { message_thread_id: threadId });

  const modelNames = args.slice(1).includes('all') ? MODEL_NAMES : args.slice(1);
  let results = [];

  for (const modelName of modelNames) {
    if (!MODEL_NAMES.includes(modelName)) { results.push(`❌ Unknown model: ${modelName}`); continue; }
    const person = await findPerson(modelName);
    if (!person) { results.push(`❌ Not found: ${modelName}`); continue; }
    await markSent(video.id, person.id, true);
    results.push(`✅ ${video.name} → ${person.name}`);
  }

  bot.sendMessage(chatId, `📤 *Send Report*\n\n${results.join('\n')}\n\n_App updated automatically_`, { message_thread_id: threadId, parse_mode: 'Markdown' });
});

// ── /forward #N model1 model2 ... | all ──
bot.onText(/\/forward (.+)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id;
  const args = match[1].trim().toLowerCase().split(/\s+/);

  const video = await findVideo(args[0]);
  if (!video) return bot.sendMessage(chatId, `❌ Could not find video: "${args[0]}"`, { message_thread_id: threadId });

  const { data: tagData } = await supabase.from('message_tags').select('message_id').eq('video_id', video.id).single();
  if (!tagData) return bot.sendMessage(chatId, `❌ No tagged message for ${video.name}. Upload to Research topic first.`, { message_thread_id: threadId });

  const modelNames = args.slice(1).includes('all') ? MODEL_NAMES : args.slice(1);
  let results = [];

  for (const modelName of modelNames) {
    if (!MODEL_NAMES.includes(modelName)) { results.push(`❌ Unknown: ${modelName}`); continue; }
    const topicId = TOPICS[modelName];
    const person = await findPerson(modelName);
    if (!person) { results.push(`❌ Not found: ${modelName}`); continue; }
    const forwarded = await forwardToTopic(tagData.message_id, topicId);
    if (forwarded) {
      await markSent(video.id, person.id, true);
      results.push(`✅ ${video.name} → ${person.name}`);
    } else {
      results.push(`❌ Failed to forward to ${modelName}`);
    }
  }

  bot.sendMessage(chatId, `📤 *Forward Report*\n\n${results.join('\n')}\n\n_App updated automatically_`, { message_thread_id: threadId, parse_mode: 'Markdown' });
});

// ── /unsend #N model1 ... | all ──
bot.onText(/\/unsend (.+)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id;
  const args = match[1].trim().toLowerCase().split(/\s+/);
  if (args.length < 2) return bot.sendMessage(chatId, '❌ Usage: /unsend #N modelname', { message_thread_id: threadId });

  const video = await findVideo(args[0]);
  if (!video) return bot.sendMessage(chatId, `❌ Could not find: "${args[0]}"`, { message_thread_id: threadId });

  const modelNames = args.slice(1).includes('all') ? MODEL_NAMES : args.slice(1);
  let results = [];

  for (const modelName of modelNames) {
    const person = await findPerson(modelName);
    if (!person) { results.push(`❌ Unknown: ${modelName}`); continue; }
    await markSent(video.id, person.id, false);
    results.push(`↩️ ${video.name} → ${person.name} unsent`);
  }

  bot.sendMessage(chatId, results.join('\n'), { message_thread_id: threadId });
});

// ── /retag #N ──
bot.onText(/\/retag (#?\d+)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id;
  if (!msg.reply_to_message) return bot.sendMessage(chatId, '❌ Reply to a video and use /retag #N', { message_thread_id: threadId });

  const num = parseInt(match[1].replace('#', ''));
  const video = await findVideo(String(num));
  if (!video) return bot.sendMessage(chatId, `❌ Research #${num} not found`, { message_thread_id: threadId });

  await saveMessageTag(msg.reply_to_message.message_id, num, video.id);
  const thumbUrl = await saveThumbnail(msg.reply_to_message, video.id, num);
  const thumbStatus = thumbUrl ? '🖼 Thumbnail updated ✅' : '';

  bot.sendMessage(chatId, `✅ Retagged as *Research #${num}* (${video.name})\n${thumbStatus}`, { message_thread_id: threadId, parse_mode: 'Markdown' });
});

// ── /list modelname ──
bot.onText(/\/list (.+)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id;
  const person = await findPerson(match[1].trim().toLowerCase());
  if (!person) return bot.sendMessage(chatId, `❌ Unknown model: ${match[1]}`, { message_thread_id: threadId });

  const videos = await getSortedVideos();
  const { data: sentData } = await supabase.from('sent_status').select('*').eq('person_id', person.id).eq('is_sent', true);
  const sentVideoIds = sentData?.map(s => s.video_id) || [];
  const sentVideos = videos.filter(v => sentVideoIds.includes(v.id));

  if (!sentVideos.length) return bot.sendMessage(chatId, `📭 No videos sent to ${person.name} yet.`, { message_thread_id: threadId });

  const list = sentVideos.map((v, i) => `${i + 1}. Fansly Video ${i + 1} _(${v.name})_`).join('\n');
  bot.sendMessage(chatId, `📋 *${person.name}'s Videos* (${sentVideos.length} total)\n\n${list}`, { message_thread_id: threadId, parse_mode: 'Markdown' });
});

// ── /status ──
bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id;
  const [videos, people, { data: sentData }] = await Promise.all([
    getVideos(), getPeople(),
    supabase.from('sent_status').select('*').eq('is_sent', true)
  ]);
  const total = videos.length * people.length;
  const sent = sentData?.length || 0;
  const pct = total ? Math.round(sent / total * 100) : 0;
  let modelStats = '';
  for (const person of people) {
    const ps = sentData?.filter(s => s.person_id === person.id).length || 0;
    const filled = Math.round(ps / videos.length * 10);
    modelStats += `\n${'█'.repeat(filled)}${'░'.repeat(10 - filled)} *${person.name}*: ${ps}/${videos.length}`;
  }
  bot.sendMessage(chatId, `📊 *Fansly FYP Tracker Status*\n\n🎬 Research Videos: ${videos.length}\n👥 Models: ${people.length}\n✅ Sent: ${sent}/${total} (${pct}%)\n\n*Per Model:*${modelStats}`, { message_thread_id: threadId, parse_mode: 'Markdown' });
});

// ── /help ──
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id;
  bot.sendMessage(chatId,
    `🤖 *Fansly FYP Bot Commands*\n\n*Auto-tagging:*\nUpload video to Research topic → bot tags it automatically\n\n*Auto-forwarding:*\nToggle in web app → bot forwards to model topic automatically\n\n/forward #N model1 ... | all\n_Manually forward video to model topics_\n\n/send #N model1 ... | all\n_Mark as sent without forwarding_\n\n/unsend #N model1 ... | all\n_Mark as unsent_\n\n/retag #N\n_Reply to video to reassign number_\n\n/list modelname\n_Videos sent to a model_\n\n/status\n_Overall tracker stats_\n\nModels: lola, josie, emma, akasha, myla, grace, mia`,
    { message_thread_id: threadId, parse_mode: 'Markdown' }
  );
});

// ── Start Realtime listener ──
startRealtimeListener().then(() => {
  console.log('✅ Realtime listener started');
}).catch(e => {
  console.error('❌ Failed to start Realtime listener:', e);
});
