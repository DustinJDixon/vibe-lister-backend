import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";
import qs from "qs";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

// Store user sessions temporarily (use Redis/DB in production)
const userSessions = new Map();

async function getSpotifyToken() {
  const tokenResponse = await axios.post(
    "https://accounts.spotify.com/api/token",
    qs.stringify({ grant_type: "client_credentials" }),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization:
          "Basic " +
          Buffer.from(
            `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
          ).toString("base64"),
      },
    }
  );
  return tokenResponse.data.access_token;
}

app.post("/generate-playlist", async (req, res) => {
  try {
    const { mood, songCount = 10, genres = [] } = req.body;
    if (!mood) return res.status(400).json({ error: "Mood is required" });

    const aiResponse = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4",
        messages: [
          { role: "system", content: "You are a playlist curator." },
          {
            role: "user",
            content: `Generate a fun playlist name and ${songCount} song suggestions (artist + title) for this mood: ${mood}${genres.length > 0 ? `. IMPORTANT: Only include songs from one of these genres: ${genres.join(', ')}. Do not include any songs from other genres.` : ''}`,
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const rawPlaylist = aiResponse.data.choices[0].message.content;
    const songLines = rawPlaylist
      .split("\n")
      .filter((line) => line.match(/[-–]|by/i))
      .slice(0, songCount);

    const spotifyToken = await getSpotifyToken();
    const tracks = [];
    for (const line of songLines) {
      try {
        const searchResponse = await axios.get(
          "https://api.spotify.com/v1/search",
          {
            headers: { Authorization: `Bearer ${spotifyToken}` },
            params: { q: line, type: "track", limit: 1 },
          }
        );
        const track = searchResponse.data.tracks.items[0];
        if (track) {
          tracks.push({
            title: track.name,
            artist: track.artists.map((a) => a.name).join(", "),
            url: track.external_urls.spotify,
          });
        }
      } catch (e) {
        console.warn("Spotify search failed for:", line);
      }
    }

    res.json({
      playlistName: rawPlaylist.split("\n")[0] || "Your Mood Playlist",
      tracks,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Server error generating playlist" });
  }
});

// Spotify OAuth endpoints
app.get("/auth/spotify", (req, res) => {
  const scopes = "playlist-modify-public playlist-modify-private";
  const redirectUri = process.env.SPOTIFY_REDIRECT_URI || "https://vibe-lister-ui.onrender.com";
  const authUrl = `https://accounts.spotify.com/authorize?response_type=code&client_id=${process.env.SPOTIFY_CLIENT_ID}&scope=${encodeURIComponent(scopes)}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  res.json({ authUrl });
});

app.post("/auth/callback", async (req, res) => {
  try {
    const { code } = req.body;
    const redirectUri = process.env.SPOTIFY_REDIRECT_URI || "https://vibe-lister-ui.onrender.com";
    
    const tokenResponse = await axios.post(
      "https://accounts.spotify.com/api/token",
      qs.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString("base64")}`,
        },
      }
    );

    const { access_token, refresh_token } = tokenResponse.data;
    const sessionId = Math.random().toString(36).substring(7);
    userSessions.set(sessionId, { access_token, refresh_token });
    
    res.json({ sessionId });
  } catch (error) {
    console.error("OAuth error:", error.response?.data || error.message);
    res.status(400).json({ error: "Authentication failed" });
  }
});

app.post("/create-spotify-playlist", async (req, res) => {
  try {
    const { sessionId, playlistName, tracks } = req.body;
    const session = userSessions.get(sessionId);
    
    if (!session) {
      return res.status(401).json({ error: "Invalid session" });
    }

    // Get user profile
    const userResponse = await axios.get("https://api.spotify.com/v1/me", {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    const userId = userResponse.data.id;

    // Create playlist
    const playlistResponse = await axios.post(
      `https://api.spotify.com/v1/users/${userId}/playlists`,
      {
        name: playlistName,
        description: "Created with Vibe Lister",
        public: false,
      },
      {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
      }
    );

    const playlistId = playlistResponse.data.id;

    // Search and add tracks
    const trackUris = [];
    for (const track of tracks) {
      try {
        const searchResponse = await axios.get(
          "https://api.spotify.com/v1/search",
          {
            headers: { Authorization: `Bearer ${session.access_token}` },
            params: { q: `${track.title} ${track.artist}`, type: "track", limit: 1 },
          }
        );
        const foundTrack = searchResponse.data.tracks.items[0];
        if (foundTrack) {
          trackUris.push(foundTrack.uri);
        }
      } catch (e) {
        console.warn(`Failed to find track: ${track.title} by ${track.artist}`);
      }
    }

    // Add tracks to playlist
    if (trackUris.length > 0) {
      await axios.post(
        `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
        { uris: trackUris },
        {
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            "Content-Type": "application/json",
          },
        }
      );
    }

    res.json({
      success: true,
      playlistUrl: playlistResponse.data.external_urls.spotify,
      tracksAdded: trackUris.length,
    });
  } catch (error) {
    console.error("Playlist creation error:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to create playlist" });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
