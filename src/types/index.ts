export interface User {
  id: string;
  name: string;
  email: string;
  avatar?: string;
  npub?: string;
  role: 'customer' | 'merchant';
}

export interface Balance {
  total: number;
  unit: string;
  fiatEquivalent?: number;
  fiatUnit?: string;
}

export interface Transaction {
  id: string;
  type: 'send' | 'receive' | 'purchase' | 'redeem';
  amount: number;
  unit: string;
  description: string;
  counterparty?: string;
  timestamp: Date;
  status: 'completed' | 'pending' | 'failed';
}

export interface Voucher {
  id: string;
  amount: number;
  unit: string;
  status: 'active' | 'claimed' | 'expired' | 'redeemed';
  code?: string;
  expiresAt?: Date;
  createdAt: Date;
  memo?: string;
}

export interface Card {
  id: string;
  name: string;
  type: 'debit' | 'cash';
  balance: number;
  unit: string;
  lastFour?: string;
}
