// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.7.6;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IFactory} from "./IFactory.sol";
import {IInstanceRegistry} from "./InstanceRegistry.sol";
import {IUniversalVault} from "../UniversalVault.sol";
import {ProxyFactory} from "./ProxyFactory.sol";

interface ITokenURIHandler {
    function tokenURI(uint256 tokenId, bool exists) external view returns (string memory);
}

/// @title Vault Factory
/// @dev Security contact: dev-support@ampleforth.org
contract VaultFactory is IFactory, IInstanceRegistry, ERC721, Ownable {
    address private immutable _template;

    address private _tokenURIHandler;

    constructor(address template) ERC721("Universal Vault v1", "VAULT-v1") {
        require(template != address(0), "VaultFactory: invalid template");
        _template = template;
    }

    /* registry functions */

    function isInstance(address instance) external view override returns (bool validity) {
        return ERC721._exists(uint256(instance));
    }

    function instanceCount() external view override returns (uint256 count) {
        return ERC721.totalSupply();
    }

    function instanceAt(uint256 index) external view override returns (address instance) {
        return address(ERC721.tokenByIndex(index));
    }

    /* factory functions */

    function create(bytes calldata) external override returns (address vault) {
        return create();
    }

    function create2(bytes calldata, bytes32 salt) external override returns (address vault) {
        return create2(salt);
    }

    function create() public returns (address vault) {
        // create clone and initialize
        vault = ProxyFactory._create(_template, abi.encodeWithSelector(IUniversalVault.initialize.selector));

        // mint nft to caller
        ERC721._safeMint(msg.sender, uint256(vault));

        // emit event
        emit InstanceAdded(vault);

        // explicit return
        return vault;
    }

    function create2(bytes32 salt) public returns (address vault) {
        // create clone and initialize
        vault = ProxyFactory._create2(_template, abi.encodeWithSelector(IUniversalVault.initialize.selector), salt);

        // mint nft to caller
        ERC721._safeMint(msg.sender, uint256(vault));

        // emit event
        emit InstanceAdded(vault);

        // explicit return
        return vault;
    }

    /* getter functions */

    function getTemplate() external view returns (address template) {
        return _template;
    }

    function predictCreate2Address(bytes32 salt) external view returns (address instance) {
        return Clones.predictDeterministicAddress(_template, salt, address(this));
    }

    function addressToUint(address vault) external pure returns (uint256 tokenId) {
        return uint256(vault);
    }

    function uint256ToAddress(uint256 tokenId) external pure returns (address vault) {
        return address(tokenId);
    }

    /* tokenURI functions */

    function setTokenURIHandler(address tokenURIHandler) external onlyOwner {
        _tokenURIHandler = tokenURIHandler;
    }

    function tokenURI(uint256 tokenId) public view virtual override returns (string memory) {
        address tokenURIHandler = _tokenURIHandler;
        if (tokenURIHandler == address(0)) {
            return super.tokenURI(tokenId);
        } else {
            return ITokenURIHandler(tokenURIHandler).tokenURI(tokenId, _exists(tokenId));
        }
    }
}
