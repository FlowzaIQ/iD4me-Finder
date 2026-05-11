// ?? STANDALONE ZAPIER WEBHOOK TESTER

// ?? 1. PASTE YOUR ZAPIER CATCH HOOK URL HERE
const ZAPIER_CATCH_HOOK_URL = "https://hooks.zapier.com/hooks/catch/24979801/up0gems/";

async function testZapierWebhook() {
    // 2. We build a fake lead package
    // NOTE: Include email so HubSpot can create/update the contact reliably.
    const payload = {
        email: "gregory.brandtman@example.com",
        firstname: "Gregory",
        lastname: "Brandtman",
        phone: "0412345678",
        address: "42 Wallaby Way, Sydney",
        lifecyclestage: "lead"
    };

    console.log("?? Firing test payload to Zapier Catch Hook...");

    try {
        // 3. We send the POST request
        const response = await fetch(ZAPIER_CATCH_HOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        // 4. We read the bouncer's response
        if (response.ok) {
            console.log("\n? SUCCESS! The VIP passed the bouncer.");
            console.log("Zapier accepted the payload.");
            console.log("Next: check your Zap run history and HubSpot Contacts.");
        } else {
            console.log("\n? FAILED. The bouncer rejected the pass. Reason:");
            console.log(data.message || data);
        }

    } catch (error) {
        console.error("\n?? Network Crash:", error.message);
    }
}

testZapierWebhook();
