export default async function handler(req, res) {

    if (req.method !== "POST") {
        return res.status(405).json({
            error: "Method not allowed"
        });
    }

    try {

        const subscription = req.body;

        if (!subscription ||
            !subscription.endpoint) {

            return res.status(400).json({
                error: "Invalid subscription"
            });
        }

        /*
         * Nanti subscription akan disimpan
         * dalam database/KV.
         */

        console.log(
            "XAUUSD PUSH SUBSCRIPTION",
            JSON.stringify(subscription)
        );

        return res.status(200).json({
            success: true
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            error: "Subscription failed"
        });

    }
}
