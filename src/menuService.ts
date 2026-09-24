import { pool } from "./db";

export interface MenuItemInput {
  name: string;
  priceCents: number;
  isAvailable?: boolean;
}

export async function listMenuItems() {
  const { rows } = await pool.query(
    `SELECT id, name, price_cents, is_available, created_at
     FROM menu_items
     ORDER BY name ASC`
  );
  return rows;
}

export async function createMenuItem(input: MenuItemInput) {
  const { rows } = await pool.query(
    `INSERT INTO menu_items (name, price_cents, is_available)
     VALUES ($1, $2, $3)
     RETURNING id, name, price_cents, is_available, created_at`,
    [input.name, input.priceCents, input.isAvailable ?? true]
  );
  return rows[0];
}

export async function updateMenuItem(id: string, input: Partial<MenuItemInput>) {
  const { rows } = await pool.query(
    `UPDATE menu_items
     SET name = COALESCE($2, name),
         price_cents = COALESCE($3, price_cents),
         is_available = COALESCE($4, is_available)
     WHERE id = $1
     RETURNING id, name, price_cents, is_available, created_at`,
    [id, input.name ?? null, input.priceCents ?? null, input.isAvailable ?? null]
  );
  if (rows.length === 0) {
    throw new Error("Menu item not found");
  }
  return rows[0];
}

export async function deleteMenuItem(id: string): Promise<void> {
  const { rowCount } = await pool.query(`DELETE FROM menu_items WHERE id = $1`, [id]);
  if (rowCount === 0) {
    throw new Error("Menu item not found");
  }
}
