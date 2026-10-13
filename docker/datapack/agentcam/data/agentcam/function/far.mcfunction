# no spot sees the shelter (trees all round, a hillside): a view of the place from outside anyway, never a wall in front
# of the lens (agentcam:good_far: room, 5.4 blocks or more away, 4 blocks of open line toward the bot), 8 out and 8 up
# (45 degrees) in 8 directions, else 3 out and 12 up; the HUD says the body is sheltered
scoreboard players set #np agentcam_y 8
function agentcam:near_dirs
execute if score #f agentcam_y matches 0 run scoreboard players set #np agentcam_y 9
execute if score #f agentcam_y matches 0 run function agentcam:near_dirs
execute if score #f agentcam_y matches 1 run scoreboard players set #on agentcam_y 2
execute if score #f agentcam_y matches 1 run scoreboard players set #hv agentcam_y 2
