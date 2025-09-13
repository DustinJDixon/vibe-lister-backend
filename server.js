import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";
import qs from "qs";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

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
    const { mood } = req.body;
    if (!mood) return res.status(400).json({ error: "Mood is required" });

    const aiResponse = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4",
        messages: [
          { role: "system", content: "You are a playlist curator." },
          {
            role: "user",
            content: `Generate a fun playlist name and 10 song suggestions (artist + title) for this mood: ${mood}`,
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
      .slice(0, 10);

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
