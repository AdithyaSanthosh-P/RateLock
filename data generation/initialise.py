import psycopg
from faker import Faker

conn = psycopg.connect(
    dbname="ratelock",
    user="postgres",
    password="postgres123",
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
""", ("pro", 500))

conn.commit()

cursor.execute("SELECT id FROM tiers WHERE name = 'free'")
free_tier_id = cursor.fetchone()[0]

cursor.execute("SELECT id FROM tiers WHERE name = 'pro'")
pro_tier_id = cursor.fetchone()[0]

for i in range(10):
    username = fake.user_name()
    tier_id = free_tier_id if i % 2 == 0 else pro_tier_id
    
    cursor.execute("""
        INSERT INTO users (username, tier_id) 
        VALUES (%s, %s)
        ON CONFLICT (username) DO NOTHING
    """, (username, tier_id))

conn.commit()
cursor.close()
conn.close()

