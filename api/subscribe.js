export default async function handler(req,res){

    if(req.method!=="POST"){

        return res.status(405).json({
            error:"Method not allowed"
        });

    }

    try{

        const subscription =
            req.body;

        if(!subscription){

            return res.status(400).json({
                error:"Missing subscription"
            });

        }

        /*
         * TEMPORARY STORAGE
         *
         * Untuk production kita akan sambungkan
         * kepada database/KV.
         */

        console.log(
            "PUSH SUBSCRIPTION:",
            JSON.stringify(subscription)
        );

        return res.status(200).json({
            success:true
        });

    }catch(error){

        console.error(error);

        return res.status(500).json({
            error:"Subscription failed"
        });

    }

}
