// This script runs in the main page context to access YouTube's native player API securely
(function() {
    let hooked = false;
    function getPlayer() {
        return document.getElementById('movie_player');
    }
    function hookPlayer() {
        const player = getPlayer();
        if (player && player.addEventListener && !hooked) {
            player.addEventListener('onPlaybackQualityChange', (quality) => {
                window.postMessage({ type: 'AM_QUALITY_CHANGE', quality: quality }, '*');
            });
            hooked = true;
        }
    }

    // Handle quality-control requests from the content script's isolated world
    window.addEventListener('message', (event) => {
        if (event.source !== window || !event.data) return;
        const msg = event.data;

        if (msg.type === 'AM_SET_QUALITY_REQUEST' && msg.quality) {
            const player = getPlayer();
            if (!player) {
                window.postMessage({ type: 'AM_QUALITY_STATUS', quality: null, error: 'no-player' }, '*');
                return;
            }
            try {
                if (player.setPlaybackQualityRange) player.setPlaybackQualityRange(msg.quality, msg.quality);
                if (player.setPlaybackQuality) player.setPlaybackQuality(msg.quality);
                const current = player.getPlaybackQuality ? player.getPlaybackQuality() : null;
                window.postMessage({ type: 'AM_QUALITY_STATUS', quality: current, requested: msg.quality }, '*');
            } catch (e) {
                window.postMessage({ type: 'AM_QUALITY_STATUS', quality: null, error: String(e) }, '*');
            }
        } else if (msg.type === 'AM_GET_QUALITY_REQUEST') {
            const player = getPlayer();
            const current = player && player.getPlaybackQuality ? player.getPlaybackQuality() : null;
            window.postMessage({ type: 'AM_QUALITY_STATUS', quality: current }, '*');
        }
    });

    hookPlayer();
    document.addEventListener('yt-navigate-finish', hookPlayer);
    setInterval(hookPlayer, 2000);
})();
