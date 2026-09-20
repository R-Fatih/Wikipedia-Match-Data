/**
 * MackolikScraper - Fetches match events from Maçkolik API
 */
class MackolikScraper {
    constructor() {
        // Custom Cloudflare Worker proxy (best option)
        // IMPORTANT: Replace with your Cloudflare Worker URL if needed
        this.customProxyUrl = "https://tffproxy.arfatihim.workers.dev/";

        // Fallback CORS proxy options
        this.proxyUrls = [
            'https://api.codetabs.com/v1/proxy?quest='
        ];
        this.currentProxyIndex = 0;
        this.timeout = 120000;
        this.playerNameResolver = new PlayerName();
    }

    /**
     * Get current proxy URL
     */
    getProxyUrl() {
        return this.proxyUrls[this.currentProxyIndex];
    }

    /**
     * Switch to next proxy
     */
    switchProxy() {
        this.currentProxyIndex = (this.currentProxyIndex + 1) % this.proxyUrls.length;
    }

    /**
     * Get match events from Maçkolik API
     * @param {string} matchId - Maçkolik match ID
     * @returns {Promise<{homeGoals: string, awayGoals: string}>}
     */
    async getMatchEvents(matchId) {
        if (!matchId) {
            return { homeGoals: '', awayGoals: '' };
        }

        const mackolikUrl = `https://arsiv.mackolik.com/Match/MatchData.aspx?t=dtl&id=${matchId}&s=0`;

        // 1. Try custom Cloudflare Worker proxy first
        if (this.customProxyUrl) {
            try {
                const proxyUrl = this.customProxyUrl + "?url=" + encodeURIComponent(mackolikUrl);
                const response = await this.fetchWithTimeout(proxyUrl, this.timeout);

                if (response.ok) {
                    const text = await response.text();
                    const json = JSON.parse(this.sanitizeJson(text));
                    console.log('Maçkolik: Using custom Cloudflare Worker proxy');
                    // Success - return immediately without trying other proxies
                    return await this.processEvents(json);
                }
            } catch (error) {
                console.warn('Maçkolik custom proxy failed:', error.message);
            }
        }

        // 2. Fallback to public proxies if custom didn't work
        let json = null;
        let attempts = 0;
        const maxAttempts = this.proxyUrls.length * 2;

        while (!json && attempts < maxAttempts) {
            try {
                const proxyUrl = this.getProxyUrl() + encodeURIComponent(mackolikUrl);
                const response = await this.fetchWithTimeout(proxyUrl, this.timeout);

                if (!response.ok) throw new Error(`HTTP ${response.status}`);

                const text = await response.text();
                json = JSON.parse(this.sanitizeJson(text));
                console.log(`Maçkolik: Using public proxy ${this.currentProxyIndex}`);
                // Success - return immediately
                return await this.processEvents(json);
            } catch (error) {
                console.warn(`Maçkolik proxy ${this.currentProxyIndex} failed:`, error.message);
                this.switchProxy();
                attempts++;
            }
        }

        // 3. Last resort: Try direct URL (may work in some environments)
        try {
            console.log('Maçkolik: Trying direct URL...');
            const response = await this.fetchWithTimeout(mackolikUrl, this.timeout);

            if (response.ok) {
                const text = await response.text();
                const json = JSON.parse(this.sanitizeJson(text));
                console.log('Maçkolik: Direct URL successful');
                return await this.processEvents(json);
            }
        } catch (error) {
            console.warn('Maçkolik direct URL failed:', error.message);
        }

        console.error('Maçkolik API bağlantısı başarısız (tüm yöntemler denendi)');
        return { homeGoals: '', awayGoals: '' };
    }

    /**
     * Get full match data from Maçkolik API without TFF data
     * @param {string} matchId - Maçkolik match ID
     * @returns {Promise<Object>} Match data object with teams, score, and formatted goals
     */
    async getMatchData(matchId) {
        if (!matchId) {
            throw new Error('Maçkolik ID belirtilmedi');
        }

        const mackolikUrl = `https://arsiv.mackolik.com/Match/MatchData.aspx?t=dtl&id=${matchId}&s=0`;
        let json = null;

        // 1. Try custom Cloudflare Worker proxy first
        if (this.customProxyUrl) {
            try {
                const proxyUrl = this.customProxyUrl + "?url=" + encodeURIComponent(mackolikUrl);
                const response = await this.fetchWithTimeout(proxyUrl, this.timeout);
                if (response.ok) {
                    const text = await response.text();
                    json = JSON.parse(this.sanitizeJson(text));
                }
            } catch (error) {
                console.warn('Maçkolik custom proxy failed:', error.message);
            }
        }

        // 2. Fallback to public proxies if custom didn't work
        if (!json) {
            let attempts = 0;
            const maxAttempts = this.proxyUrls.length * 2;
            while (!json && attempts < maxAttempts) {
                try {
                    const proxyUrl = this.getProxyUrl() + encodeURIComponent(mackolikUrl);
                    const response = await this.fetchWithTimeout(proxyUrl, this.timeout);
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    const text = await response.text();
                    json = JSON.parse(this.sanitizeJson(text));
                } catch (error) {
                    console.warn(`Maçkolik proxy ${this.currentProxyIndex} failed:`, error.message);
                    this.switchProxy();
                    attempts++;
                }
            }
        }

        // 3. Fallback to direct URL
        if (!json) {
            try {
                const response = await this.fetchWithTimeout(mackolikUrl, this.timeout);
                if (response.ok) {
                    const text = await response.text();
                    json = JSON.parse(this.sanitizeJson(text));
                }
            } catch (error) {
                console.warn('Maçkolik direct URL failed:', error.message);
            }
        }

        if (!json) {
            throw new Error(`Maçkolik API bağlantısı başarısız oldu (ID: ${matchId})`);
        }

        const eventsData = await this.processEvents(json);

        return {
            matchId: String(matchId),
            homeTeam: json.home || 'Ev Sahibi',
            awayTeam: json.away || 'Deplasman',
            homeScore: eventsData.homeScore,
            awayScore: eventsData.awayScore,
            halfTimeScore: json.d?.ht || '',
            homeGoals: eventsData.homeGoals,
            awayGoals: eventsData.awayGoals,
            homeLineup: json.h || [],
            awayLineup: json.a || [],
            events: json.e || [],
            rawJson: json
        };
    }

    /**
     * Sanitize JSON string by fixing invalid escape sequences
     * Maçkolik sometimes returns backslash-escaped single quotes which is invalid JSON
     */
    sanitizeJson(text) {
        // Fix invalid escape sequences:
        // \' is not valid in JSON, replace with just '
        // Also handle other potential issues
        return text
            .replace(/\\'/g, "'")  // \' -> '
            .replace(/[\x00-\x1F\x7F]/g, ''); // Remove control characters
    }

    /**
     * Process match events from JSON
     */
    async processEvents(json) {
        const matchDetails = [];

        // Extract score from d.s field (e.g., "2 - 0")
        let homeScore = null;
        let awayScore = null;
        if (json.d && json.d.s) {
            const scoreParts = json.d.s.split(' - ');
            if (scoreParts.length === 2) {
                homeScore = parseInt(scoreParts[0].trim());
                awayScore = parseInt(scoreParts[1].trim());
            }
        }

        // Process events for both teams
        if (json.e && Array.isArray(json.e)) {
            for (const event of json.e) {
                const side = parseInt(event[0]);
                const minute = parseInt(event[1]);
                const playerId = parseInt(event[2]);
                const playerName = event[3];
                const eventType = event[4].toString();
                const eventDetail = event[5]?.d;

                // Skip substitutions (type 4)
                if (eventType === '4') continue;

                let eventName = '';
                let eventId = 0;

                switch (eventType) {
                    case '1':
                        if (eventDetail == '2') {
                            eventName = 'baspenaltı';
                            eventId = 1;
                        } else if (eventDetail == '3') {
                            eventName = 'gol'; // kendi kalesine
                            eventId = 2;
                        } else {
                            eventName = 'gol';
                            eventId = 0;
                        }
                        break;
                    case '2':
                        eventName = 'sarı kart';
                        eventId = 3;
                        break;
                    case '3':
                        if (eventDetail == '1') {
                            eventName = 'kırmızı kart'; // çift sarıdan
                            eventId = 4;
                        } else {
                            eventName = 'kırmızı kart'; // direk
                            eventId = 5;
                        }
                        break;
                    case '7':
                        eventName = 'kaçpenaltı';
                        eventId = 6;
                        break;
                    default:
                        continue;
                }

                matchDetails.push({
                    playerId,
                    playerName,
                    eventId,
                    eventMinute: minute,
                    side,
                    eventName
                });
            }
        }

        // Process home team events
        const homeEvents = matchDetails.filter(e => e.side === 1);
        const awayEvents = matchDetails.filter(e => e.side === 2);

        // Get unique player IDs and resolve names
        const homePlayerIds = [...new Set(homeEvents.map(e => e.playerId))];
        const awayPlayerIds = [...new Set(awayEvents.map(e => e.playerId))];

        const homePlayerNames = {};
        const awayPlayerNames = {};

        for (const id of homePlayerIds) {
            homePlayerNames[id] = await this.playerNameResolver.getPlayerName(id);
        }

        for (const id of awayPlayerIds) {
            awayPlayerNames[id] = await this.playerNameResolver.getPlayerName(id);
        }

        // Format output
        const homeGoals = this.formatEvents(homeEvents, homePlayerNames, true);
        const awayGoals = this.formatEvents(awayEvents, awayPlayerNames, false);

        return { homeGoals, awayGoals, homeScore, awayScore };
    }

    /**
     * Format events for Wikipedia output
     */
    formatEvents(events, playerNames, isHome) {
        if (events.length === 0) return '';

        // Group by player and track first event minute
        const grouped = {};
        const firstEventMinute = {}; // Track first event minute for each player

        for (const event of events) {
            if (!grouped[event.playerId]) {
                grouped[event.playerId] = [];
                firstEventMinute[event.playerId] = event.eventMinute;
            } else {
                // Update if this event is earlier
                if (event.eventMinute < firstEventMinute[event.playerId]) {
                    firstEventMinute[event.playerId] = event.eventMinute;
                }
            }
            grouped[event.playerId].push(event);
        }

        // Sort player IDs by their first event minute
        const playerIds = Object.keys(grouped).sort((a, b) => {
            return firstEventMinute[a] - firstEventMinute[b];
        });

        const lines = [];

        for (let i = 0; i < playerIds.length; i++) {
            const playerId = playerIds[i];
            const playerEvents = grouped[playerId];
            const wikiName = playerNames[playerId];

            // Sort player's events by minute
            playerEvents.sort((a, b) => a.eventMinute - b.eventMinute);

            // Group events by event type
            const eventsByType = {};
            for (const event of playerEvents) {
                if (!eventsByType[event.eventId]) {
                    eventsByType[event.eventId] = [];
                }
                eventsByType[event.eventId].push(event);
            }

            // Create an array of groups and sort them by the minute of their first event
            const eventGroups = [];
            for (const eventId in eventsByType) {
                eventGroups.push({
                    eventId: parseInt(eventId),
                    events: eventsByType[eventId],
                    firstMinute: eventsByType[eventId][0].eventMinute
                });
            }
            eventGroups.sort((a, b) => a.firstMinute - b.firstMinute);

            let eventTexts = [];
            for (const group of eventGroups) {
                const typeEvents = group.events;
                const eventParts = typeEvents.map(e => {
                    let part = `{{${e.eventName}|`;
                    if (e.eventId === 4) part += '1|'; // çift sarıdan
                    if (e.eventId === 5) part += '0|'; // direk kırmızı
                    part += e.eventMinute;
                    if (e.eventId === 2) part += '|kk'; // kendi kalesine
                    part += '}}';
                    return part;
                });
                eventTexts.push(eventParts.join('|'));
            }

            const eventsStr = eventTexts.join(' ');

            if (isHome) {
                lines.push(`* [[${wikiName}]] ${eventsStr}`);
            } else {
                lines.push(`* ${eventsStr} [[${wikiName}]]`);
            }
        }

        let result = lines.join('\n');

        // Fix multiple goal format
        result = result.replace(/\}\}\|\{\{gol/g, '|');
        result = result.replace(/\}\}\|\{\{baspenaltı/g, '|');
        result = result.replace(/\}\}\|\{\{kaçpenaltı/g, '|');

        return result;
    }

    /**
     * Get player details (name, nationality, birth date) from Maçkolik player page
     * @param {number|string} id - Maçkolik player ID
     */
    async getPlayerDetails(id) {
        const url = `https://arsiv.mackolik.com/Futbolcu/${id}/`;
        let html = null;

        // 1. Try custom proxy
        if (this.customProxyUrl) {
            try {
                const proxyUrl = this.customProxyUrl + "?url=" + encodeURIComponent(url);
                const response = await this.fetchWithTimeout(proxyUrl, 20000);
                if (response.ok) {
                    html = await response.text();
                }
            } catch (e) {
                console.warn('Custom proxy failed for player details:', e.message);
            }
        }

        // 2. Try fallback proxies
        if (!html) {
            for (let i = 0; i < this.proxyUrls.length; i++) {
                try {
                    const proxyUrl = this.proxyUrls[i] + encodeURIComponent(url);
                    const response = await this.fetchWithTimeout(proxyUrl, 20000);
                    if (response.ok) {
                        html = await response.text();
                        break;
                    }
                } catch (e) {
                    console.warn(`Proxy ${i} failed for player details:`, e.message);
                }
            }
        }

        // 3. Try direct
        if (!html) {
            try {
                const response = await this.fetchWithTimeout(url, 20000);
                if (response.ok) {
                    html = await response.text();
                }
            } catch (e) {
                console.warn('Direct URL failed for player details:', e.message);
            }
        }

        const result = {
            id: id,
            name: '-',
            nationality: '-',
            birthDate: '-',
            url: `https://arsiv.mackolik.com/Futbolcu/${id}/`
        };

        if (!html) return result;

        try {
            const doc = new DOMParser().parseFromString(html, 'text/html');

            // 1. Name
            const nameEl = doc.querySelector('h1[itemprop="name"]') || doc.querySelector('#dvPlayerDetails h1');
            if (nameEl) {
                result.name = nameEl.textContent.trim();
            }

            // 2. Nationality
            const flagImg = doc.querySelector('#dvPlayerDetails img[src*="flags/"]');
            if (flagImg) {
                result.nationality = flagImg.getAttribute('alt')?.trim() || '';
                if (!result.nationality && flagImg.parentElement) {
                    result.nationality = flagImg.parentElement.textContent.trim();
                }
            }

            // 3. Birth Date
            const timeEl = doc.querySelector('time[itemprop="birthDate"]');
            if (timeEl) {
                result.birthDate = timeEl.textContent.trim();
            } else {
                const infoDivs = doc.querySelectorAll('#dvPlayerInfo div');
                for (let i = 0; i < infoDivs.length; i++) {
                    if (infoDivs[i].textContent.includes('D.Tarihi')) {
                        const nextDiv = infoDivs[i + 1];
                        if (nextDiv) {
                            result.birthDate = nextDiv.textContent.replace(':', '').trim().split(' ')[0];
                        }
                        break;
                    }
                }
            }
        } catch (e) {
            console.error('Error parsing player details HTML:', e);
        }

        return result;
    }

    /**
     * Fetch with timeout
     */
    async fetchWithTimeout(url, timeout) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        try {
            const response = await fetch(url, { signal: controller.signal });
            clearTimeout(timeoutId);
            return response;
        } catch (error) {
            clearTimeout(timeoutId);
            throw error;
        }
    }
}

// Export for use in other modules
if (typeof window !== 'undefined') {
    window.MackolikScraper = MackolikScraper;
}
