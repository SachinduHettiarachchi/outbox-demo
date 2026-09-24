import { createMenuItem, listMenuItems } from "./menuService";
import { createOrder } from "./orderService";
import { OutboxRelay } from "./relay";

async function main(): Promise<void> {
  const relay = new OutboxRelay();
  relay.start();

  let menu = await listMenuItems();
  if (menu.length === 0) {
    await createMenuItem({ name: "Margherita Pizza", priceCents: 1200 });
    await createMenuItem({ name: "Cheeseburger", priceCents: 950 });
    await createMenuItem({ name: "Iced Tea", priceCents: 300 });
    menu = await listMenuItems();
  }
  const [pizza, burger, tea] = menu;

  await createOrder("11111111-1111-1111-1111-111111111111", [
    { menuItemId: pizza.id, quantity: 1 },
    { menuItemId: tea.id, quantity: 2 },
  ]);
  await createOrder("22222222-2222-2222-2222-222222222222", [
    { menuItemId: burger.id, quantity: 1 },
  ]);
  await createOrder("11111111-1111-1111-1111-111111111111", [
    { menuItemId: burger.id, quantity: 2 },
    { menuItemId: tea.id, quantity: 1 },
  ]);

  console.log(
    "Seeded menu + created 3 orders (2 customers). Relay is running and publishing events..."
  );
  console.log("Press Ctrl+C to stop.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
