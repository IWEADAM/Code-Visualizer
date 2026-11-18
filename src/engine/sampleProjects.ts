import { buildProjectModel } from './parser';
import { ProjectModel } from '../types/codeMap';

export const SAMPLE_PROJECTS: ProjectModel[] = [
  buildProjectModel(
    'repo-sentinel-auth',
    'sentinel-core-engine',
    'Full-stack Python authentication, age-gate verification, risk calculation, and database pipeline.',
    [
      {
        path: 'src/main.py',
        content: `from auth import authenticate_user
from database import connect_db, save_audit_log
from utils import calculate

def main(username, age, score, db_offline):
    conn = connect_db(db_offline)
    is_valid = authenticate_user(username, age)
    if is_valid == True:
        bonus = calculate(score)
        final_score = bonus + 10
        save_audit_log(username, final_score)
        return final_score
    else:
        save_audit_log(username, 0)
        return 0

if __name__ == "__main__":
    main("Adam", 17, 92, False)
`,
      },
      {
        path: 'src/auth.py',
        content: `from database import query_user
from utils import minor_user, adult_user

def authenticate_user(username, age):
    record = query_user(username)
    if age >= 18:
        status = adult_user(username)
        return True
    else:
        status = minor_user(username)
        return False
`,
      },
      {
        path: 'src/utils.py',
        content: `def calculate(x):
    if x > 10:
        doubled = x * 2
        return doubled
    else:
        added = x + 5
        return added

def minor_user(username):
    for attempt in range(2):
        restricted = True
    return "MINOR_RESTRICTED"

def adult_user(username):
    verified = True
    return "ADULT_VERIFIED"
`,
      },
      {
        path: 'src/database.py',
        content: `from config.settings import load_config

def connect_db(db_offline):
    cfg = load_config()
    if db_offline == True:
        raise ConnectionError("Database connection refused on port 5432")
    else:
        connected = True
        return connected

def query_user(username):
    if username == "Adam":
        found = True
        return found
    else:
        found = False
        return found

def save_audit_log(username, score):
    saved = score
    return saved
`,
      },
      {
        path: 'config/settings.py',
        content: `def load_config():
    timeout = 30
    retries = 3
    return timeout
`,
      },
      {
        path: 'tests/test_auth.py',
        content: `from auth import authenticate_user

def test_minor_flow():
    res = authenticate_user("Adam", 17)
    return res
`,
      },
    ],
    {
      username: 'Adam',
      age: 17,
      score: 92,
      x: 15,
      db_offline: false,
    },
    [
      {
        name: 'Minor User Path (age = 17)',
        description: 'Traces age >= 18 as FALSE → routes to minor_user() restriction branch.',
        inputs: { username: 'Adam', age: 17, score: 92, x: 15, db_offline: false },
      },
      {
        name: 'Adult Verified Path (age = 20)',
        description: 'Traces age >= 18 as TRUE → executes calculate(92) → doubles score & saves.',
        inputs: { username: 'Adam', age: 20, score: 92, x: 15, db_offline: false },
      },
      {
        name: 'Low Score Branch (x = 6)',
        description: 'Traces adult user with score = 6 → x > 10 is FALSE → executes x + 5.',
        inputs: { username: 'Adam', age: 22, score: 6, x: 6, db_offline: false },
      },
      {
        name: 'Database Runtime Error (ConnectionError)',
        description: 'Simulates database connection failure inside database.connect_db().',
        inputs: { username: 'Adam', age: 20, score: 92, x: 15, db_offline: true },
      },
    ],
    'https://github.com/acme-labs/sentinel-core-engine'
  ),

  buildProjectModel(
    'repo-payment-gateway-ts',
    'stripe-order-router-ts',
    'TypeScript payment orchestration service with fraud scoring, switch dispatch, and retry loops.',
    [
      {
        path: 'src/index.ts',
        content: `import { verifyRisk } from './fraud';
import { dispatchPayment } from './gateway';

export function main(amount: number, riskScore: number, currency: string) {
  const safe = verifyRisk(riskScore);
  if (safe == true) {
    const receipt = dispatchPayment(amount, currency);
    return receipt;
  } else {
    return "BLOCKED_HIGH_RISK";
  }
}
`,
      },
      {
        path: 'src/fraud.ts',
        content: `export function verifyRisk(riskScore: number) {
  if (riskScore > 80) {
    return false;
  } else if (riskScore > 50) {
    const manualReview = true;
    return true;
  } else {
    return true;
  }
}
`,
      },
      {
        path: 'src/gateway.ts',
        content: `export function dispatchPayment(amount: number, currency: string) {
  switch (currency) {
    
  }
  if (amount > 1000) {
    const fee = amount * 2;
    return fee;
  } else {
    const fee = amount + 5;
    return fee;
  }
}
`,
      },
    ],
    {
      amount: 1250,
      riskScore: 24,
      currency: 'USD',
    },
    [
      {
        name: 'Standard High-Value Order',
        description: 'Low risk (24) and amount > 1000 triggers premium settlement path.',
        inputs: { amount: 1250, riskScore: 24, currency: 'USD' },
      },
      {
        name: 'Fraud Blocked Order (riskScore = 95)',
        description: 'Triggers fraud.ts riskScore > 80 branch and halts payment.',
        inputs: { amount: 500, riskScore: 95, currency: 'USD' },
      },
    ],
    'https://github.com/acme-labs/stripe-order-router-ts'
  ),
];
