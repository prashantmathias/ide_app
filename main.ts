import { Application, Router } from "https://deno.land/x/oak/mod.ts";

const app = new Application();
const router = new Router();

router.get("/", (ctx) => {
    ctx.response.body = "Hello from Oak!";
});

app.use(router.routes());
app.use(router.allowedMethods());

app.listen({ port: 8000 });
console.log("Server is running on http://localhost:8000");



// Try Deno APIs:
// Deno.readTextFileSync("main.ts")
