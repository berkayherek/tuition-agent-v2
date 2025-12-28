import { Timestamp } from 'firebase/firestore';

export interface Message {
  id: string;
  text: string;
  role: 'user' | 'model';
  createdAt: Timestamp;
  processed?: boolean;
}

export enum CollectionNames {
  CHATS = 'chats'
}