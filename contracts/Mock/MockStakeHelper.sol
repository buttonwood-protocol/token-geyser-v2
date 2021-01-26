// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.7.6;
pragma abicoder v2;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IGeyser} from "../Geyser.sol";
import {IFactory} from "../Factory/IFactory.sol";
import {IUniversalVault} from "../UniversalVault.sol";

contract MockStakeHelper {
    function flashStake(
        address geyser,
        address vault,
        address recipient,
        uint256 amount,
        bytes calldata depositPermission,
        bytes calldata withdrawPermission
    ) external {
        IGeyser(geyser).deposit(vault, amount, depositPermission);
        IGeyser(geyser).withdraw(vault, recipient, amount, withdrawPermission);
    }

    function depositBatch(
        address[] calldata geysers,
        address[] calldata vaults,
        uint256[] calldata amounts,
        bytes[] calldata permissions
    ) external {
        for (uint256 index = 0; index < vaults.length; index++) {
            IGeyser(geysers[index]).deposit(vaults[index], amounts[index], permissions[index]);
        }
    }
}