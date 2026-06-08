const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// --- PROFANITY FILTER API HELPER ---
async function containsProfanity(text) {
  try {
      const response = await fetch(`https://www.purgomalum.com/service/containsprofanity?text=${encodeURIComponent(text)}`);
      const result = await response.text();
      return result === 'true'; 
  } catch (error) {
      return false; 
  }
}

// --- HTML & CODE INJECTION FILTER ---
function sanitizeText(str) {
  if (!str) return "";
  return str.replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    const url = new URL(request.url);
    const path = url.pathname;

    // --- AGGRESSIVE DATABASE AUTO-HEALER ---
    const queries = [
        "ALTER TABLE users ADD COLUMN session_token TEXT",
        "ALTER TABLE users ADD COLUMN last_save_time TIMESTAMP",
        "ALTER TABLE users ADD COLUMN equipped_weapon TEXT DEFAULT 'none'",
        "ALTER TABLE users ADD COLUMN equipped_coat TEXT DEFAULT 'none'",
        "ALTER TABLE users ADD COLUMN unlocked_weapons TEXT DEFAULT '[\"none\"]'",
        "ALTER TABLE users ADD COLUMN unlocked_coats TEXT DEFAULT '[\"none\"]'",
        "ALTER TABLE users ADD COLUMN guild TEXT DEFAULT ''",
        "ALTER TABLE users ADD COLUMN is_guild_leader INTEGER DEFAULT 0",
        "ALTER TABLE users ADD COLUMN guild_coins INTEGER DEFAULT 0",
        "ALTER TABLE users ADD COLUMN jolly_sweets INTEGER DEFAULT 0",
        "ALTER TABLE users ADD COLUMN spooky_sweets INTEGER DEFAULT 0",
        "ALTER TABLE users ADD COLUMN guild_rank INTEGER DEFAULT 1",
        "CREATE TABLE IF NOT EXISTS guild_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_tag TEXT, username TEXT, message TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)",
        "ALTER TABLE guilds ADD COLUMN name_color TEXT DEFAULT '#f9a826'",
        "ALTER TABLE guilds ADD COLUMN active_crest_id INTEGER DEFAULT 0",
        "ALTER TABLE guilds ADD COLUMN unlocked_crests TEXT DEFAULT '[0]'",
        "ALTER TABLE guilds ADD COLUMN members_count INTEGER DEFAULT 1",
        "ALTER TABLE guilds ADD COLUMN war_coins INTEGER DEFAULT 0",
        "ALTER TABLE guilds ADD COLUMN active_title_id INTEGER DEFAULT 0",
        "ALTER TABLE guilds ADD COLUMN unlocked_titles TEXT DEFAULT '[]'",
        "ALTER TABLE guilds ADD COLUMN pet_tokens INTEGER DEFAULT 0",
        "ALTER TABLE guilds ADD COLUMN notice TEXT DEFAULT 'Welcome to the Alliance!'"
    ];
    for (let q of queries) { try { await env.DB.prepare(q).run(); } catch(err) {} }

    try {
      if (path === "/api/login" && request.method === "POST") {
        const { username, password_hash } = await request.json();
        const user = await env.DB.prepare("SELECT * FROM users WHERE username = ? AND password_hash = ?").bind(username, password_hash).first();
        if (!user) return new Response(JSON.stringify({ success: false, error: "Invalid credentials" }), { headers: corsHeaders });
        
        const sessionToken = crypto.randomUUID(); 
        
        // Auto-upgrade legacy guild leaders to R5
        if (user.is_guild_leader === 1 && user.guild_rank !== 5) {
            await env.DB.prepare("UPDATE users SET guild_rank = 5 WHERE username = ?").bind(username).run();
            user.guild_rank = 5;
        }

        await env.DB.prepare("UPDATE users SET session_token = ?, last_seen = CURRENT_TIMESTAMP WHERE username = ?").bind(sessionToken, username).run();
        
        try { user.unlocked_skins = JSON.parse(user.unlocked_skins || '["default"]'); } catch(e) { user.unlocked_skins = ["default"]; }
        try { user.unlocked_weapons = JSON.parse(user.unlocked_weapons || '["none"]'); } catch(e) { user.unlocked_weapons = ["none"]; }
        try { user.unlocked_coats = JSON.parse(user.unlocked_coats || '["none"]'); } catch(e) { user.unlocked_coats = ["none"]; }
        
        user.session_token = sessionToken; delete user.password_hash; 
        return new Response(JSON.stringify({ success: true, userData: user }), { headers: corsHeaders });
      }

      if (path === "/api/register" && request.method === "POST") {
        const { username, password_hash } = await request.json();
        if (!username || !password_hash || username.length > 15) return new Response(JSON.stringify({ success: false, error: "Invalid username" }), { headers: corsHeaders });
        if (await containsProfanity(username)) return new Response(JSON.stringify({ success: false, error: "Username contains inappropriate language." }), { headers: corsHeaders });

        const existing = await env.DB.prepare("SELECT username FROM users WHERE username = ?").bind(username).first();
        if (existing) return new Response(JSON.stringify({ success: false, error: "Username taken" }), { headers: corsHeaders });
        await env.DB.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").bind(username, password_hash).run();
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }

      // --- SECURE SAVE & ANTI-CHEAT ENGINE ---
      if (path === "/api/save" && request.method === "POST") {
        const data = await request.json();
        const userProfile = await env.DB.prepare("SELECT * FROM users WHERE username = ? AND session_token = ?").bind(data.username, data.session_token).first();
        if (!userProfile) return new Response(JSON.stringify({ success: false, error: "Session expired." }), { headers: corsHeaders });

        if (data.white_shards - (userProfile.white_shards || 0) > 50 || data.black_shards - (userProfile.black_shards || 0) > 50 || data.added_points > 10000000000000000000000) {
            return new Response(JSON.stringify({ success: false, error: "Anti-Cheat Triggered." }), { status: 403, headers: corsHeaders });
        }

        await env.DB.prepare(`
          UPDATE users SET high_score = MAX(high_score, ?), equipped_skin = ?, equipped_weapon = ?, equipped_coat = ?, 
          white_shards = ?, black_shards = ?, jolly_sweets = ?, spooky_sweets = ?, unlocked_skins = ?, unlocked_weapons = ?, unlocked_coats = ?, guild_coins = ?, last_seen = CURRENT_TIMESTAMP, last_save_time = CURRENT_TIMESTAMP
          WHERE username = ?
        `).bind(data.high_score || 0, data.equipped_skin || 'default', data.equipped_weapon || 'none', data.equipped_coat || 'none', 
          data.white_shards || 0, data.black_shards || 0, data.jolly_sweets || 0, data.spooky_sweets || 0,
          JSON.stringify(data.unlocked_skins || ["default"]), JSON.stringify(data.unlocked_weapons || ["none"]), JSON.stringify(data.unlocked_coats || ["none"]), data.guild_coins || 0, data.username).run();

        let bossDefeatedNotification = false;
        if (data.added_points > 0 && userProfile.guild && userProfile.guild !== "") {
          const gTag = userProfile.guild;
          await env.DB.prepare("INSERT INTO guild_boss_damage (guild_tag, damage) VALUES (?, ?) ON CONFLICT(guild_tag) DO UPDATE SET damage = damage + ?").bind(gTag, data.added_points, data.added_points).run();

          const lvlRow = await env.DB.prepare("SELECT value FROM global_state WHERE key='boss_level'").first();
          let lvl = lvlRow ? parseInt(lvlRow.value) : 1;
          let maxHp = 500000 * Math.pow(1.3, lvl - 1);
          
          const hpRow = await env.DB.prepare("SELECT value FROM global_state WHERE key='boss_hp'").first();
          let currentHp = hpRow ? parseInt(hpRow.value) : maxHp;

          currentHp -= data.added_points;

          if (currentHp <= 0) {
            bossDefeatedNotification = true;

            // ---> NEW PROPORTIONAL PAYOUT ENGINE <---
            const participatingGuilds = (await env.DB.prepare("SELECT guild_tag, damage FROM guild_boss_damage").all()).results;
            
            // Calculate total damage dealt by all guilds
            let totalDamage = participatingGuilds.reduce((sum, g) => sum + g.damage, 0);
            if (totalDamage < 1) totalDamage = 1; // Prevent division by zero
            
            // Calculate the total exponential reward pool for this level
            let totalPool = 1200 * Math.pow(1.5, lvl - 1); 

            // Distribute coins by % of damage done
            for (let g of participatingGuilds) {
                let payout = Math.max(1, Math.floor((g.damage / totalDamage) * totalPool));
                try {
                    await env.DB.prepare("UPDATE guilds SET war_coins = war_coins + ? WHERE tag = ?").bind(payout, g.guild_tag).run();
                } catch(e) {}
            }

            await env.DB.prepare("DELETE FROM guild_boss_damage").run();
            lvl += 1; if (lvl > 100) lvl = 1; 
            currentHp = 500000 * Math.pow(1.3, lvl - 1);
            await env.DB.prepare("INSERT INTO global_state (key, value) VALUES ('boss_level', ?) ON CONFLICT(key) DO UPDATE SET value = ?").bind(lvl.toString(), lvl.toString()).run();
          }
          await env.DB.prepare("INSERT INTO global_state (key, value) VALUES ('boss_hp', ?) ON CONFLICT(key) DO UPDATE SET value = ?").bind(currentHp.toString(), currentHp.toString()).run();
        }

        if (data.added_points > 0) {
            const today = new Date().toISOString().split('T')[0];
            await env.DB.prepare("INSERT INTO global_quest (date_str, daily_points) VALUES (?, ?) ON CONFLICT(date_str) DO UPDATE SET daily_points = daily_points + ?").bind(today, data.added_points, data.added_points).run();
        }
        return new Response(JSON.stringify({ success: true, bossDefeatedNotification }), { headers: corsHeaders });
      }

      // --- SERVER DATA FETCH ---
      if (path === "/api/server_data" && request.method === "GET") {
        const username = url.searchParams.get("username") || null;
        const today = new Date().toISOString().split('T')[0];
        
        let leaderboard = [], guildWars = [], guildScores = [];
        try {
            leaderboard = (await env.DB.prepare("SELECT u.username, u.guild, u.high_score as score, g.name_color, g.active_crest_id FROM users u LEFT JOIN guilds g ON u.guild = g.tag ORDER BY u.high_score DESC LIMIT 15").all()).results;
            guildWars = (await env.DB.prepare("SELECT gb.guild_tag as tag, gb.damage, g.name_color, g.active_crest_id FROM guild_boss_damage gb JOIN guilds g ON gb.guild_tag = g.tag ORDER BY gb.damage DESC LIMIT 5").all()).results;
            guildScores = (await env.DB.prepare("SELECT u.guild as tag, SUM(u.high_score) as total_score, g.name_color, g.active_crest_id FROM users u JOIN guilds g ON u.guild = g.tag WHERE u.guild != '' GROUP BY u.guild ORDER BY total_score DESC LIMIT 5").all()).results;
        } catch(e) {}
        
        const stateLevel = await env.DB.prepare("SELECT value FROM global_state WHERE key='boss_level'").first();
        const stateHp = await env.DB.prepare("SELECT value FROM global_state WHERE key='boss_hp'").first();
        let bLvl = stateLevel ? parseInt(stateLevel.value) : 1;
        let bMax = 500000 * Math.pow(1.3, bLvl - 1);
        let bCur = stateHp ? parseInt(stateHp.value) : bMax;

        let userGuildInfo = null; let pendingRequests = []; 
        let guildMembers = []; let guildChat = [];

        if (username) {
          const userProfile = await env.DB.prepare("SELECT guild, guild_rank FROM users WHERE username = ?").bind(username).first();
          if (userProfile && userProfile.guild) {
            userGuildInfo = await env.DB.prepare("SELECT * FROM guilds WHERE tag = ?").bind(userProfile.guild).first();
            
            // Fetch Members and Chat
            try { guildMembers = (await env.DB.prepare("SELECT username, guild_rank, last_seen FROM users WHERE guild = ? ORDER BY guild_rank DESC").bind(userProfile.guild).all()).results; } catch(e){}
            try { guildChat = (await env.DB.prepare("SELECT username, message, timestamp FROM guild_messages WHERE guild_tag = ? ORDER BY id DESC LIMIT 40").bind(userProfile.guild).all()).results; } catch(e){}

            // Fetch Pending Requests if Officer (R3+)
            if (userProfile.guild_rank >= 3) {
                pendingRequests = (await env.DB.prepare("SELECT id, username FROM guild_requests WHERE guild_tag = ? AND status = 'pending'").bind(userProfile.guild).all()).results;
            }
          }
        }

        return new Response(JSON.stringify({ 
          success: true, 
          live_event_inactive: "boss_frenzy", 
          leaderboard, 
          guildWars, 
          guildScores, 
          userGuildInfo, 
          pendingRequests, 
          guildMembers,
          guildChat,
          boss: { name: bLvl === 20 ? "Abyssal Leviathan [The Eternal]" : "Abyssal Leviathan", level: bLvl, current_hp: bCur, max_hp: bMax }
        }), { headers: corsHeaders });
      }

      // --- PERSONAL SHOP ---
      if (path === "/api/shop/personal" && request.method === "POST") {
        const { username, session_token, type, itemId, cost, currency } = await request.json();
        const user = await env.DB.prepare("SELECT * FROM users WHERE username = ? AND session_token = ?").bind(username, session_token).first();
        if (!user) return new Response(JSON.stringify({ success: false, error: "Session expired." }), { headers: corsHeaders });
        let cType = currency === "jolly" ? "jolly_sweets" : (currency === "spooky" ? "spooky_sweets" : "guild_coins");
        if ((user[cType] || 0) < cost) return new Response(JSON.stringify({ success: false, error: `Not enough ${cType.replace('_', ' ')}.` }), { headers: corsHeaders });
        let unlockedList = JSON.parse(type === 'weapon' ? (user.unlocked_weapons || '["none"]') : (user.unlocked_coats || '["none"]'));
        if (!unlockedList.includes(itemId)) unlockedList.push(itemId);
        await env.DB.prepare(`UPDATE users SET ${cType} = ${cType} - ?, ${type === 'weapon' ? 'unlocked_weapons' : 'unlocked_coats'} = ? WHERE username = ?`).bind(cost, JSON.stringify(unlockedList), username).run();
        return new Response(JSON.stringify({ success: true, newCoins: (user[cType] || 0) - cost }), { headers: corsHeaders });
      }

      // --- GUILD RANKS & MANAGEMENT ENDPOINTS ---

      if (path === "/api/guild/chat" && request.method === "POST") {
        const { username, session_token, message } = await request.json();
        const user = await env.DB.prepare("SELECT guild, guild_rank FROM users WHERE username = ? AND session_token = ?").bind(username, session_token).first();
        if (!user || !user.guild) return new Response(JSON.stringify({success: false, error: "Not in an Alliance."}), {headers: corsHeaders});
        if (user.guild_rank < 2) return new Response(JSON.stringify({success: false, error: "Rank 2 required to chat."}), {headers: corsHeaders});
        
        let safeMessage = sanitizeText(message).substring(0, 150);
        if (await containsProfanity(safeMessage)) safeMessage = "***[Message Blocked by Filter]***";
        
        await env.DB.prepare("INSERT INTO guild_messages (guild_tag, username, message) VALUES (?, ?, ?)").bind(user.guild, username, safeMessage).run();
        return new Response(JSON.stringify({success: true}), {headers: corsHeaders});
      }

      if (path === "/api/guild/notice" && request.method === "POST") {
        const { username, session_token, notice } = await request.json();
        const user = await env.DB.prepare("SELECT guild, guild_rank FROM users WHERE username = ? AND session_token = ?").bind(username, session_token).first();
        if (!user || user.guild_rank < 4) return new Response(JSON.stringify({success: false, error: "Rank 4 required."}), {headers: corsHeaders});
        
        let safeNotice = sanitizeText(notice).substring(0, 120);
        if (await containsProfanity(safeNotice)) safeNotice = "Notice removed for inappropriate language.";
        
        await env.DB.prepare("UPDATE guilds SET notice = ? WHERE tag = ?").bind(safeNotice, user.guild).run();
        return new Response(JSON.stringify({success: true}), {headers: corsHeaders});
      }

      if (path === "/api/guild/kick" && request.method === "POST") {
        const { username, session_token, target_user } = await request.json();
        const user = await env.DB.prepare("SELECT guild, guild_rank FROM users WHERE username = ? AND session_token = ?").bind(username, session_token).first();
        if (!user || user.guild_rank < 4) return new Response(JSON.stringify({success: false, error: "Rank 4 required."}), {headers: corsHeaders});
        
        const target = await env.DB.prepare("SELECT guild, guild_rank FROM users WHERE username = ?").bind(target_user).first();
        if (!target || target.guild !== user.guild) return new Response(JSON.stringify({success: false, error: "User not in guild."}), {headers: corsHeaders});
        
        if (user.guild_rank <= target.guild_rank) return new Response(JSON.stringify({success: false, error: "Cannot kick someone of equal or higher rank."}), {headers: corsHeaders});
        
        await env.DB.prepare("UPDATE users SET guild = '', guild_rank = 1 WHERE username = ?").bind(target_user).run();
        await env.DB.prepare("UPDATE guilds SET members_count = members_count - 1 WHERE tag = ?").bind(user.guild).run();
        return new Response(JSON.stringify({success: true}), {headers: corsHeaders});
      }

      if (path === "/api/guild/set_rank" && request.method === "POST") {
        const { username, session_token, target_user, new_rank } = await request.json();
        const user = await env.DB.prepare("SELECT guild, guild_rank FROM users WHERE username = ? AND session_token = ?").bind(username, session_token).first();
        if (!user || user.guild_rank < 5) return new Response(JSON.stringify({success: false, error: "Must be Leader (R5)."}), {headers: corsHeaders});
        if (new_rank < 1 || new_rank > 4) return new Response(JSON.stringify({success: false, error: "Invalid rank."}), {headers: corsHeaders});
        
        const target = await env.DB.prepare("SELECT guild, guild_rank FROM users WHERE username = ?").bind(target_user).first();
        if (!target || target.guild !== user.guild) return new Response(JSON.stringify({success: false, error: "User not in guild."}), {headers: corsHeaders});
        
        await env.DB.prepare("UPDATE users SET guild_rank = ? WHERE username = ?").bind(new_rank, target_user).run();
        return new Response(JSON.stringify({success: true}), {headers: corsHeaders});
      }

      if (path === "/api/guild/leave" && request.method === "POST") {
        const { username, session_token } = await request.json();
        const user = await env.DB.prepare("SELECT guild FROM users WHERE username = ? AND session_token = ?").bind(username, session_token).first();
        if(user && user.guild) {
             await env.DB.prepare("UPDATE guilds SET members_count = members_count - 1 WHERE tag = ?").bind(user.guild).run();
             await env.DB.prepare("UPDATE users SET guild = '', guild_rank = 1, is_guild_leader = 0 WHERE username = ?").bind(username).run();
        }
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }

      if (path === "/api/guild/equip_title" && request.method === "POST") {
        const { username, session_token, titleId } = await request.json();
        const check = await env.DB.prepare("SELECT guild, guild_rank FROM users WHERE username = ? AND session_token = ?").bind(username, session_token).first();
        if (check && check.guild_rank >= 4) {
            await env.DB.prepare("UPDATE guilds SET active_title_id = ? WHERE tag = ?").bind(titleId, check.guild).run();
            return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
        }
        return new Response(JSON.stringify({ success: false, error: "Rank 4 required" }), { headers: corsHeaders });
      }

      if (path === "/api/guild/customize" && request.method === "POST") {
        const { username, session_token, action, payload } = await request.json();
        const check = await env.DB.prepare("SELECT guild, guild_rank FROM users WHERE username = ? AND session_token = ?").bind(username, session_token).first();
        if (!check || check.guild_rank < 4) return new Response(JSON.stringify({ success: false, error: "Rank 4 required." }), { headers: corsHeaders });

        const guildRow = await env.DB.prepare("SELECT * FROM guilds WHERE tag = ?").bind(check.guild).first();

        if (action === "buy_crest") {
            if (guildRow.war_coins < payload.cost) return new Response(JSON.stringify({ success: false, error: "Insufficient War Coins." }), { headers: corsHeaders });
            let unlockedCrests = JSON.parse(guildRow.unlocked_crests || "[0]");
            if (!unlockedCrests.includes(payload.crestId)) unlockedCrests.push(payload.crestId);
            await env.DB.prepare("UPDATE guilds SET war_coins = war_coins - ?, unlocked_crests = ?, active_crest_id = ? WHERE tag = ?").bind(payload.cost, JSON.stringify(unlockedCrests), payload.crestId, check.guild).run();
        } else if (action === "set_color") {
            await env.DB.prepare("UPDATE guilds SET name_color = ? WHERE tag = ?").bind(payload.color, check.guild).run();
        }
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }

      if (path === "/api/guild/buy_title" && request.method === "POST") {
        const { username, session_token, titleId } = await request.json();
        const check = await env.DB.prepare("SELECT guild, guild_rank FROM users WHERE username = ? AND session_token = ?").bind(username, session_token).first();
        if (!check || check.guild_rank < 4) return new Response(JSON.stringify({ success: false, error: "Rank 4 required." }), { headers: corsHeaders });
        const allianceRow = await env.DB.prepare("SELECT * FROM guilds WHERE tag = ?").bind(check.guild).first();
        
        const costsMap = { 1:10, 2:25, 3:50, 4:100, 5:150, 6:200, 7:300, 8:450, 9:600, 10:800, 11:1000, 12:1300, 13:1600, 14:2000, 15:2500, 16:3100, 17:3800, 18:4600, 19:5500, 20:7000, 21:10000 };
        const price = costsMap[titleId] || 999999;
        if (allianceRow.war_coins < price) return new Response(JSON.stringify({ success: false, error: "Insufficient War Coins" }), { headers: corsHeaders });

        let unlockedTitles = JSON.parse(allianceRow.unlocked_titles || "[]");
        if (!unlockedTitles.includes(titleId)) unlockedTitles.push(titleId);
        await env.DB.prepare("UPDATE guilds SET war_coins = war_coins - ?, active_title_id = ?, unlocked_titles = ? WHERE tag = ?").bind(price, titleId, JSON.stringify(unlockedTitles), check.guild).run();
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }

      if (url.pathname === "/api/guild/upgrade_pet" && request.method === "POST") {
        const body = await request.json();
        const user = await env.DB.prepare("SELECT * FROM users WHERE username = ? AND session_token = ?").bind(body.username, body.session_token).first();
        if (!user || !user.guild) return new Response(JSON.stringify({success: false, error: "Not in a guild"}), {headers: corsHeaders});

        const guild = await env.DB.prepare("SELECT * FROM guilds WHERE tag = ?").bind(user.guild).first();
        let amount = parseInt(body.amount);
        if (isNaN(amount) || amount <= 0) return new Response(JSON.stringify({success: false, error: "Invalid amount"}), {headers: corsHeaders});

        let totalCost = 0; let tempTokens = guild.pet_tokens || 0; let baseCost = (body.type === 'gold') ? 100 : 10;
        for (let i = 0; i < amount; i++) { let tier = Math.floor(tempTokens / 10000); totalCost += baseCost * Math.pow(2, tier); tempTokens++; }

        if (body.type === 'war') {
            if (user.guild_rank < 4) return new Response(JSON.stringify({success: false, error: "Rank 4 required for War Coins"}), {headers: corsHeaders});
            if (guild.war_coins < totalCost) return new Response(JSON.stringify({success: false, error: "Not enough War Coins"}), {headers: corsHeaders});
            await env.DB.prepare("UPDATE guilds SET war_coins = war_coins - ?, pet_tokens = pet_tokens + ? WHERE tag = ?").bind(totalCost, amount, guild.tag).run();
        } else if (body.type === 'gold') {
            if (user.guild_coins < totalCost) return new Response(JSON.stringify({success: false, error: "Not enough Gold"}), {headers: corsHeaders});
            await env.DB.prepare("UPDATE users SET guild_coins = guild_coins - ? WHERE username = ?").bind(totalCost, user.username).run();
            await env.DB.prepare("UPDATE guilds SET pet_tokens = pet_tokens + ? WHERE tag = ?").bind(amount, guild.tag).run();
        }
        return new Response(JSON.stringify({success: true}), { headers: corsHeaders });
      }

      if (path === "/api/guild/create" && request.method === "POST") {
        const { username, session_token, guild_tag } = await request.json();
        const userProfile = await env.DB.prepare("SELECT guild FROM users WHERE username = ? AND session_token = ?").bind(username, session_token).first();
        if (!userProfile || userProfile.guild !== "") return new Response(JSON.stringify({ success: false, error: "Already in an Alliance" }), { headers: corsHeaders });
        if (await containsProfanity(guild_tag)) return new Response(JSON.stringify({ success: false, error: "Tag contains inappropriate language." }), { headers: corsHeaders });

        const exists = await env.DB.prepare("SELECT tag FROM guilds WHERE tag = ?").bind(guild_tag).first();
        if (exists) return new Response(JSON.stringify({ success: false, error: "Tag taken" }), { headers: corsHeaders });
        
        await env.DB.prepare("INSERT INTO guilds (tag, leader, members_count) VALUES (?, ?, 1)").bind(guild_tag, username).run();
        await env.DB.prepare("UPDATE users SET guild = ?, is_guild_leader = 1, guild_rank = 5 WHERE username = ?").bind(guild_tag, username).run();
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }

      if (path === "/api/guild/request_join" && request.method === "POST") {
        const { username, session_token, guild_tag } = await request.json();
        await env.DB.prepare("DELETE FROM guild_requests WHERE username = ?").bind(username).run();
        await env.DB.prepare("INSERT INTO guild_requests (guild_tag, username) VALUES (?, ?)").bind(guild_tag, username).run();
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }

      if (path === "/api/guild/handle_request" && request.method === "POST") {
        const { username, session_token, requestId, action } = await request.json();
        const check = await env.DB.prepare("SELECT guild, guild_rank FROM users WHERE username = ? AND session_token = ?").bind(username, session_token).first();
        if (!check || check.guild_rank < 3) return new Response(JSON.stringify({ success: false, error: "Rank 3 required." }), { headers: corsHeaders });
        const reqRow = await env.DB.prepare("SELECT username, guild_tag FROM guild_requests WHERE id = ?").bind(requestId).first();
        
        if (action === "approve" && reqRow) {
          await env.DB.prepare("UPDATE users SET guild = ?, is_guild_leader = 0, guild_rank = 1 WHERE username = ?").bind(reqRow.guild_tag, reqRow.username).run();
          await env.DB.prepare("UPDATE guilds SET members_count = members_count + 1 WHERE tag = ?").bind(reqRow.guild_tag).run();
          await env.DB.prepare("DELETE FROM guild_requests WHERE username = ?").bind(reqRow.username).run();
        } else {
          await env.DB.prepare("DELETE FROM guild_requests WHERE id = ?").bind(requestId).run();
        }
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }

      // --- SOCIAL (RESTORED PERFECTLY) ---
      if (path === "/api/social" && request.method === "POST") {
        const { username, session_token, action, payload } = await request.json();
        const userCheck = await env.DB.prepare("SELECT * FROM users WHERE username = ? AND session_token = ?").bind(username, session_token).first();
        if (!userCheck) return new Response(JSON.stringify({ success: false, error: "Session expired." }), { headers: corsHeaders });

        if (action === "get") {
            const { results: friends } = await env.DB.prepare(`SELECT f.*, u.last_seen FROM friends f JOIN users u ON u.username = (CASE WHEN f.user1 = ? THEN f.user2 ELSE f.user1 END) WHERE f.user1 = ? OR f.user2 = ?`).bind(username, username, username).all();
            const today = new Date().toISOString().split('T')[0];
            const { results: challenges } = await env.DB.prepare("SELECT * FROM challenges WHERE (challenger = ? OR challenged = ?) AND date_str = ?").bind(username, username, today).all();
            return new Response(JSON.stringify({ success: true, friends, challenges }), { headers: corsHeaders });
        }
        if (action === "add_friend") {
            const exists = await env.DB.prepare("SELECT username FROM users WHERE username = ?").bind(payload.target).first();
            if (!exists) return new Response(JSON.stringify({ success: false, error: "User not found" }), { headers: corsHeaders });
            await env.DB.prepare("INSERT INTO friends (user1, user2, status) VALUES (?, ?, 'pending')").bind(username, payload.target).run();
            return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
        }
        if (action === "respond_friend") {
            if (payload.response === 'declined') await env.DB.prepare("DELETE FROM friends WHERE id = ?").bind(payload.id).run();
            else await env.DB.prepare("UPDATE friends SET status = 'accepted' WHERE id = ?").bind(payload.id).run();
            return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
        }
        if (action === "send_challenge") {
            const targetExists = await env.DB.prepare("SELECT username FROM users WHERE username = ?").bind(payload.target).first();
            if(!targetExists) return new Response(JSON.stringify({ success: false, error: "Target not found." }), { headers: corsHeaders });
            
            const today = new Date().toISOString().split('T')[0];
            await env.DB.prepare("INSERT INTO challenges (challenger, challenged, goal, status, date_str) VALUES (?, ?, ?, 'pending', ?)").bind(username, payload.target, payload.goal, today).run();
            return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
        }
        if (action === "respond_challenge") {
            if (payload.response === 'declined') await env.DB.prepare("DELETE FROM challenges WHERE id = ?").bind(payload.id).run();
            else await env.DB.prepare("UPDATE challenges SET status = 'accepted' WHERE id = ?").bind(payload.id).run();
            return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
        }
        if (action === "win_challenge") {
            const chal = await env.DB.prepare("SELECT * FROM challenges WHERE id = ?").bind(payload.id).first();
            if (chal && chal.status === 'accepted' && chal.winner === '') {
                await env.DB.prepare("UPDATE challenges SET winner = ?, status = 'completed' WHERE id = ?").bind(username, payload.id).run();
                await env.DB.prepare("UPDATE users SET guild_coins = guild_coins + 50 WHERE username = ?").bind(username).run();
                return new Response(JSON.stringify({ success: true, awarded: true }), { headers: corsHeaders });
            }
            return new Response(JSON.stringify({ success: false }), { headers: corsHeaders });
        }
      }

      return new Response("Not Found", { status: 404, headers: corsHeaders });
    } catch (e) { 
      return new Response(JSON.stringify({ success: false, error: e.message || "Server Error" }), { status: 500, headers: corsHeaders }); 
    }
  }
};
