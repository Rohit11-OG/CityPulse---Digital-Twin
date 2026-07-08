import os
import requests
import time

from config import CITY_LAT, CITY_LON  # importing config also loads .env


class WeatherManager:
    def __init__(self, lat=CITY_LAT, lon=CITY_LON):
        self.lat = lat
        self.lon = lon
        self.last_fetch = 0
        self.fetch_interval = 300  # Cache API calls for 5 minutes (standard OWM rule)

        # Weather state defaults
        self.raining = False
        self.temp = 27.0
        self.weather_main = "Clear"

        self.api_key = os.environ.get("OPENWEATHER_API_KEY")
        self.is_mock = not self.api_key
        if self.api_key:
            print("WeatherManager: OpenWeatherMap API Key found. Real-time weather sync active.")
        else:
            print("WeatherManager: No OpenWeatherMap API Key found. Falling back to simulated weather.")

    def get_weather(self):
        """
        Queries the OpenWeatherMap API if a key is present and cached time is exceeded,
        otherwise returns current state. Falls back to mock values if no key.

        Blocking (uses requests) — call via asyncio.to_thread from async code.
        """
        if self.is_mock or not self.api_key:
            return {
                "raining": self.raining,
                "temp": self.temp,
                "weather": self.weather_main,
                "source": "simulated"
            }

        current_time = time.time()
        # Fetch only if 5 minutes have elapsed since last API call to respect free tier boundaries
        if current_time - self.last_fetch > self.fetch_interval:
            self.last_fetch = current_time
            try:
                url = f"https://api.openweathermap.org/data/2.5/weather?lat={self.lat}&lon={self.lon}&appid={self.api_key}&units=metric"
                response = requests.get(url, timeout=5)
                if response.status_code == 200:
                    data = response.json()
                    # Extract weather main condition
                    weather_desc = data.get("weather", [{}])[0].get("main", "Clear")
                    self.weather_main = weather_desc
                    self.temp = data.get("main", {}).get("temp", 27.0)

                    # Rain conditions: "Rain", "Drizzle", "Thunderstorm"
                    self.raining = weather_desc in ["Rain", "Drizzle", "Thunderstorm"]
                    print(f"WeatherManager: Synced weather: {weather_desc}, {self.temp}°C (Rain: {self.raining})")
                else:
                    print(f"WeatherManager Warning: API returned status code {response.status_code}. Fallback active.")
            except Exception as e:
                print(f"WeatherManager Error during API fetch: {e}")

        return {
            "raining": self.raining,
            "temp": self.temp,
            "weather": self.weather_main,
            "source": "api"
        }
