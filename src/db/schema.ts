import {
  pgTable, uuid, text, integer, timestamp, date, jsonb, index, uniqueIndex,
} from 'drizzle-orm/pg-core'

export const items = pgTable('items', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind', { enum: ['feed', 'carousel', 'story'] }).notNull().default('feed'),
  caption: text('caption').notNull().default(''),
  position: integer('position').notNull(),
  status: text('status', { enum: ['pending', 'posted', 'failed'] }).notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  error: text('error'),
  postedDate: date('posted_date'),
  slotIndex: integer('slot_index'),
  igMediaId: text('ig_media_id'),
  permalink: text('permalink'),
  postedAt: timestamp('posted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('items_status_position_idx').on(t.status, t.position),
  uniqueIndex('items_slot_unique_idx').on(t.postedDate, t.slotIndex),
])

export const images = pgTable('images', {
  id: uuid('id').primaryKey().defaultRandom(),
  itemId: uuid('item_id').notNull().references(() => items.id, { onDelete: 'cascade' }),
  hash: text('hash').notNull(),
  url: text('url').notNull(),
  pathname: text('pathname').notNull(),
  position: integer('position').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('images_hash_unique_idx').on(t.hash),
  index('images_item_idx').on(t.itemId),
])

export const settings = pgTable('settings', {
  id: integer('id').primaryKey().default(1),
  slots: jsonb('slots').$type<string[]>().notNull().default(['10:00', '14:00', '20:00']),
  timezone: text('timezone').notNull().default('Europe/Istanbul'),
  hashtags: text('hashtags').notNull().default(''),
})

export const metrics = pgTable('metrics', {
  itemId: uuid('item_id').primaryKey().references(() => items.id, { onDelete: 'cascade' }),
  likes: integer('likes').notNull().default(0),
  comments: integer('comments').notNull().default(0),
  reach: integer('reach').notNull().default(0),
  saved: integer('saved').notNull().default(0),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
})
