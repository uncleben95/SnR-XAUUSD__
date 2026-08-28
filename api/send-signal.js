import webpush from "web-push";

export default async function handler(req, res) {

    if (req.method !== "POST") {
        return res.status(405).json({
            error: "Method not allowed"
        });
    }

    try {

        const {
            signal,
            price,
            score
        } = req.body || {};

        if (
            signal !== "BUY" &&
            signal !== "SELL"
        ) {

            return res.status(400).json({
                error: "Invalid signal"
            });

        }

        /*
         * VAPID + subscription storage
         * akan disambungkan selepas ini.
         */

        return res.status(200).json({
            success: true,
            signal,
            price,
            score
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            error: "Push failed"
        });

    }
}
