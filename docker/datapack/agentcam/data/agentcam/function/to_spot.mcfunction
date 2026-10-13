# the eye to the spot agentcam:good kept, turned to the bot's eyes
execute at @e[type=minecraft:marker,tag=agentcam_spot,limit=1] run tp @e[type=minecraft:item_display,tag=agentcam_eye,limit=1] ~ ~ ~ facing entity @a[tag=agentcam_target,limit=1] eyes
