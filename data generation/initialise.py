import psycopg
from faker import Faker
import secrets

conn = psycopg.connect(
    dbname="ratelock",
    user="ratelock",
    password="ratelock123",
    host="localhost",
    port="5432"
)

cursor = conn.cursor()
fake = Faker()

cursor.execute("""
    INSERT INTO tiers (name, tokens_per_hour) 
    VALUES (%s, %s)
    ON CONFLICT (name) DO NOTHING
""", ("free", 100))

cursor.execute("""
    INSERT INTO tiers (name, tokens_per_hour) 
    VALUES (%s, %s)
    ON CONFLICT (name) DO NOTHING
""", ("premium", 500))

conn.commit()

cursor.execute("SELECT id FROM tiers WHERE name = 'free'")
free_tier_id = cursor.fetchone()[0]

cursor.execute("SELECT id FROM tiers WHERE name = 'premium'")
premium_tier_id = cursor.fetchone()[0]

num_users = int(input("User count: "))
user_ids = []

for i in range(num_users):
    if i < num_users / 2:
        tier_id = free_tier_id
    else:
        tier_id = premium_tier_id

    username = fake.user_name()
    api_key = secrets.token_hex(16)

    cursor.execute("""
        INSERT INTO users (username, api_key, tier_id) 
        VALUES (%s, %s, %s)
        ON CONFLICT (username) DO NOTHING
        RETURNING id
    """, (username, api_key, tier_id))

    result = cursor.fetchone()

    if result:
        user_ids.append(result[0])

conn.commit()

cursor.close()
conn.close()