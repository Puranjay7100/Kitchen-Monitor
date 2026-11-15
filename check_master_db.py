"""
Verification script: Queries the master_metrics table in your Supabase Master DB
and prints the latest 5-minute interval rows.
"""
import psycopg2
from datetime import timezone, timedelta

MASTER_DB_URL = "postgresql://postgres.vmdxwszdawcdluaignpl:The_Neotia_Uni@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres"
IST_TZ = timezone(timedelta(hours=5, minutes=30))

def check_master_metrics():
    print("\n" + "="*70)
    print(" CONNECTING TO SUPABASE MASTER DATABASE...")
    print("="*70)
    try:
        conn = psycopg2.connect(MASTER_DB_URL, connect_timeout=10)
        cur = conn.cursor()
        cur.execute("""
            SELECT window_start, hygiene_score, vehicle_count, total_orders, 
                   food_quality_score, customer_count
            FROM master_metrics
            ORDER BY window_start DESC
            LIMIT 10;
        """)
        rows = cur.fetchall()
        
        if not rows:
            print("No rows found in 'master_metrics' yet.")
        else:
            print(f"{'WINDOW START (IST)':<24} | {'HYGIENE':<8} | {'VEHICLES':<8} | {'ORDERS':<8}")
            print("-" * 70)
            for r in rows:
                raw_dt = r[0]
                w_start = raw_dt.strftime("%Y-%m-%d %H:%M") if raw_dt else "--"
                hygiene = f"{r[1]}%" if r[1] is not None else "--"
                vehicles = str(r[2])
                orders = str(r[3])
                print(f"{w_start:<24} | {hygiene:<8} | {vehicles:<8} | {orders:<8}")
        
        cur.close()
        conn.close()
        print("="*70 + "\n")
    except Exception as e:
        print("ERROR CONNECTING TO MASTER DB:", e)

if __name__ == "__main__":
    check_master_metrics()
