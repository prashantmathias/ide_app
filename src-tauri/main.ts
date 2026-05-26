import {Application} from "https://deno.land/x/aqueduct/mod.ts";

const app = new Application();

app.router.get("/", (ctx) => {
    ctx.response.body = "Hello from AhoNo!";
});

app.listen({ port: 8000 });
console.log("Server is running on http://localhost:8000");


// Try Deno APIs:
// Deno.readTextFileSync("main.ts")
